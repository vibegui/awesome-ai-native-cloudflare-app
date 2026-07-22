// The self-improvement tool group: metrics, goals, memory, hypotheses.
//
// These tools exist so a coding agent (Claude Code connected to /mcp via
// .mcp.json) can run the improvement loop against the LIVE app:
//
//   get_briefing → conclude past experiments → pick/create a hypothesis →
//   edit the code locally → deploy → record what happened.
//
// The app provides the senses (metrics), the compass (goals), and the
// notebook (memory); the agent provides the intelligence. See CLAUDE.md.
import type { Env } from "../env";
import type { ToolDef } from "./tools";

const DAY_MS = 24 * 60 * 60 * 1000;

// group_by values are mapped to SQL through this whitelist — never
// interpolate user input into SQL.
const GROUP_EXPRS: Record<string, string> = {
  day: "date(ts / 1000, 'unixepoch')",
  name: "name",
  path: "coalesce(path, '')",
  country: "coalesce(country, '')",
};

interface GoalRow {
  id: string;
  name: string;
  description: string;
  metric: string;
  target: number;
  direction: "up" | "down";
  window_days: number;
  status: string;
  created_at: number;
}

async function goalProgress(env: Env, goal: GoalRow) {
  const since = Date.now() - goal.window_days * DAY_MS;
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(value), 0) AS current FROM events WHERE name = ? AND ts >= ?",
  )
    .bind(goal.metric, since)
    .first<{ current: number }>();
  const current = row?.current ?? 0;
  const achieved = goal.direction === "up" ? current >= goal.target : current <= goal.target;
  return { ...goal, current, achieved };
}

interface BudgetRow {
  agent: string;
  weekly_tokens: number;
  granted_by: string | null;
  rationale: string;
  updated_at: number;
}

async function spent7d(env: Env, agent: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(value), 0) AS spent FROM events WHERE name = 'tokens_spent' AND ts >= ? AND lower(json_extract(dims, '$.agent')) = lower(?)",
  )
    .bind(Date.now() - 7 * DAY_MS, agent)
    .first<{ spent: number }>();
  return row?.spent ?? 0;
}

export const IMPROVE_TOOLS: ToolDef[] = [
  {
    name: "get_briefing",
    description:
      "Start here every session. Returns active goals with live progress, a 7-day metrics " +
      "summary, open hypotheses (proposed/testing), and recent memories — everything needed " +
      "to decide what to improve next.",
    inputSchema: { type: "object", properties: {} },
    async execute(env) {
      const since7d = Date.now() - 7 * DAY_MS;

      const goals = await env.DB.prepare("SELECT * FROM goals WHERE status = 'active'").all<GoalRow>();
      const goalsWithProgress = await Promise.all(goals.results.map((g) => goalProgress(env, g)));

      const [metrics, traffic, hypotheses, memories, tasks, messages, memoryCount, budgetRows, spendRows, control] = await Promise.all([
        env.DB.prepare(
          "SELECT name, COUNT(*) AS events, SUM(value) AS value FROM events WHERE ts >= ? GROUP BY name ORDER BY events DESC LIMIT 25",
        )
          .bind(since7d)
          .all(),
        env.DB.prepare(
          "SELECT COUNT(*) AS pageviews, COUNT(DISTINCT visitor) AS uniques FROM events WHERE name = 'pageview' AND ts >= ?",
        )
          .bind(since7d)
          .first(),
        env.DB.prepare(
          "SELECT * FROM hypotheses WHERE status IN ('proposed', 'testing') ORDER BY updated_at DESC LIMIT 20",
        ).all(),
        env.DB.prepare("SELECT * FROM memories ORDER BY created_at DESC LIMIT 10").all(),
        env.DB.prepare(
          "SELECT * FROM tasks WHERE status IN ('pending', 'in_progress', 'review') ORDER BY updated_at DESC LIMIT 20",
        ).all(),
        env.DB.prepare("SELECT * FROM messages ORDER BY created_at DESC LIMIT 15").all(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM memories").first<{ n: number }>(),
        env.DB.prepare("SELECT * FROM budgets ORDER BY agent").all<BudgetRow>(),
        env.DB.prepare(
          "SELECT lower(json_extract(dims, '$.agent')) AS agent, SUM(value) AS spent FROM events WHERE name = 'tokens_spent' AND ts >= ? GROUP BY 1",
        )
          .bind(since7d)
          .all<{ agent: string; spent: number }>(),
        env.DB.prepare(
          "SELECT * FROM messages WHERE room = 'control' ORDER BY created_at DESC LIMIT 1",
        ).first<{ author: string; content: string; created_at: number }>(),
      ]);

      return {
        control: control ?? null,
        paused: control ? /^pause/i.test(control.content) : false,
        goals: goalsWithProgress,
        metrics7d: metrics.results,
        traffic7d: traffic,
        openHypotheses: hypotheses.results,
        openTasks: tasks.results,
        recentRoomMessages: messages.results,
        recentMemories: memories.results,
        memoryCount: memoryCount?.n ?? 0,
        budgets: budgetRows.results.map((b) => {
          const spent = spendRows.results.find((r) => r.agent === b.agent.toLowerCase())?.spent ?? 0;
          return { agent: b.agent, weekly_tokens: b.weekly_tokens, spent_7d: spent, remaining: b.weekly_tokens - spent };
        }),
        guidance:
          "Loop: 1) conclude any 'testing' hypotheses using metrics_query (confirmed needs a " +
          "reviewer that isn't the author); 2) claim or create ONE task tied to the highest-" +
          "impact proposed hypothesis; 3) implement it in code, instrument it with track(), " +
          "deploy; 4) hypothesis_update to 'testing', task_update to review/done, memory_write " +
          "the decision, room_post a short handoff note, spend_report your session tokens. Compact memories when memoryCount > 30. Budgets are earned: efficiency (tokens per reviewed outcome) drives your allowance — see budget_status. OBEY control: if paused=true, claim/start nothing — reply in rooms only, wait for RESUME.",
      };
    },
  },
  {
    name: "metrics_query",
    description:
      "Aggregate the event stream. Filter by event name, group by day|name|path|country, " +
      "over a trailing window. Returns events count, summed value, and unique visitors per group.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Event name filter, e.g. 'pageview' (optional)" },
        since_days: { type: "number", description: "Trailing window in days (default 7, max 90)" },
        group_by: { type: "string", enum: ["day", "name", "path", "country"], description: "Default 'day'" },
      },
    },
    async execute(env, input) {
      const sinceDays = Math.min(Math.max(Number(input.since_days) || 7, 1), 90);
      const groupBy = String(input.group_by ?? "day");
      const expr = GROUP_EXPRS[groupBy];
      if (!expr) throw new Error(`group_by must be one of: ${Object.keys(GROUP_EXPRS).join(", ")}`);
      const since = Date.now() - sinceDays * DAY_MS;
      const name = input.name ? String(input.name) : null;

      const sql =
        `SELECT ${expr} AS key, COUNT(*) AS events, SUM(value) AS value, ` +
        "COUNT(DISTINCT visitor) AS uniques FROM events WHERE ts >= ? " +
        (name ? "AND name = ? " : "") +
        "GROUP BY key ORDER BY key";
      const stmt = env.DB.prepare(sql);
      const { results } = await (name ? stmt.bind(since, name) : stmt.bind(since)).all();
      return { since_days: sinceDays, group_by: groupBy, name, rows: results };
    },
  },
  {
    name: "goal_set",
    description:
      "Create or update a goal. A goal targets an event name (`metric`): progress is " +
      "SUM(value) of that event over the trailing window_days. Pass id to update.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Goal id (only when updating)" },
        name: { type: "string" },
        description: { type: "string" },
        metric: { type: "string", description: "Event name this goal tracks" },
        target: { type: "number" },
        direction: { type: "string", enum: ["up", "down"] },
        window_days: { type: "number", description: "Trailing window (default 7)" },
        status: { type: "string", enum: ["active", "achieved", "abandoned"] },
      },
      required: ["name", "metric", "target"],
    },
    async execute(env, input) {
      const id = input.id ? String(input.id) : crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO goals (id, name, description, metric, target, direction, window_days, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
           metric = excluded.metric, target = excluded.target, direction = excluded.direction,
           window_days = excluded.window_days, status = excluded.status`,
      )
        .bind(
          id,
          String(input.name),
          String(input.description ?? ""),
          String(input.metric),
          Number(input.target),
          input.direction === "down" ? "down" : "up",
          Math.max(1, Number(input.window_days) || 7),
          ["active", "achieved", "abandoned"].includes(String(input.status)) ? String(input.status) : "active",
          Date.now(),
        )
        .run();
      const goal = await env.DB.prepare("SELECT * FROM goals WHERE id = ?").bind(id).first<GoalRow>();
      return goal ? await goalProgress(env, goal) : { id };
    },
  },
  {
    name: "goal_list",
    description: "List goals with live progress (current metric value vs target).",
    inputSchema: { type: "object", properties: {} },
    async execute(env) {
      const { results } = await env.DB.prepare(
        "SELECT * FROM goals ORDER BY created_at DESC",
      ).all<GoalRow>();
      return { goals: await Promise.all(results.map((g) => goalProgress(env, g))) };
    },
  },
  {
    name: "memory_write",
    description:
      "Record to the app's lab notebook so future sessions don't rediscover it. Kinds: " +
      "observation (something the metrics show), decision (what you changed and why), " +
      "result (what a change did), lesson (a durable takeaway).",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["observation", "decision", "result", "lesson"] },
        content: { type: "string" },
        goal_id: { type: "string", description: "Related goal (optional)" },
        author: { type: "string", description: "Your agent handle (e.g. 'claude-main')" },
      },
      required: ["kind", "content"],
    },
    async execute(env, input) {
      const memory = {
        id: crypto.randomUUID(),
        kind: String(input.kind),
        content: String(input.content),
        goal_id: input.goal_id ? String(input.goal_id) : null,
        author: input.author ? String(input.author) : null,
        created_at: Date.now(),
      };
      if (!["observation", "decision", "result", "lesson"].includes(memory.kind)) {
        throw new Error("kind must be observation | decision | result | lesson");
      }
      await env.DB.prepare(
        "INSERT INTO memories (id, kind, content, goal_id, author, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(memory.id, memory.kind, memory.content, memory.goal_id, memory.author, memory.created_at)
        .run();
      return { created: memory };
    },
  },
  {
    name: "memory_delete",
    description:
      "Delete a memory by id. Used during compaction: merge duplicates into one lesson, then " +
      "delete the stale/superseded entries. Keep the notebook readable in one briefing.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    async execute(env, input) {
      const result = await env.DB.prepare("DELETE FROM memories WHERE id = ?")
        .bind(String(input.id))
        .run();
      return { deleted: result.meta.changes === 1 };
    },
  },
  {
    name: "memory_search",
    description: "Search the notebook (substring match), newest first.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to search for (optional — omit for latest)" },
        kind: { type: "string", enum: ["observation", "decision", "result", "lesson"] },
        limit: { type: "number", description: "Default 20, max 100" },
      },
    },
    async execute(env, input) {
      const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100);
      const conditions: string[] = [];
      const binds: unknown[] = [];
      if (input.query) {
        conditions.push("content LIKE ?");
        binds.push(`%${String(input.query)}%`);
      }
      if (input.kind) {
        conditions.push("kind = ?");
        binds.push(String(input.kind));
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const { results } = await env.DB.prepare(
        `SELECT * FROM memories ${where} ORDER BY created_at DESC LIMIT ${limit}`,
      )
        .bind(...binds)
        .all();
      return { memories: results };
    },
  },
  {
    name: "hypothesis_create",
    description:
      "File a falsifiable bet: 'If we <change>, then <metric> will <move> because <reason>'. " +
      "Every code change should trace back to one of these.",
    inputSchema: {
      type: "object",
      properties: {
        statement: { type: "string", description: "The full if/then/because statement" },
        goal_id: { type: "string", description: "Goal this serves (optional)" },
        expected_metric: { type: "string", description: "Event name expected to move" },
        expected_delta: { type: "string", description: "Expected effect, e.g. '+20% in 7d'" },
        author: { type: "string", description: "Your agent handle — confirming later requires a DIFFERENT reviewer" },
      },
      required: ["statement"],
    },
    async execute(env, input) {
      const now = Date.now();
      const hypothesis = {
        id: crypto.randomUUID(),
        goal_id: input.goal_id ? String(input.goal_id) : null,
        statement: String(input.statement),
        expected_metric: input.expected_metric ? String(input.expected_metric) : null,
        expected_delta: input.expected_delta ? String(input.expected_delta) : null,
        author: input.author ? String(input.author) : null,
        status: "proposed",
      };
      await env.DB.prepare(
        `INSERT INTO hypotheses (id, goal_id, statement, expected_metric, expected_delta, author, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          hypothesis.id,
          hypothesis.goal_id,
          hypothesis.statement,
          hypothesis.expected_metric,
          hypothesis.expected_delta,
          hypothesis.author,
          hypothesis.status,
          now,
          now,
        )
        .run();
      return { created: hypothesis };
    },
  },
  {
    name: "hypothesis_update",
    description:
      "Move a hypothesis through its lifecycle (proposed → testing → confirmed|refuted|abandoned) " +
      "and/or append evidence. RULE: no agent grades its own work — setting status to " +
      "'confirmed' requires reviewed_by, a different handle than the author, after an " +
      "adversarial review that tried to refute the metric interpretation.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: ["proposed", "testing", "confirmed", "refuted", "abandoned"] },
        evidence: { type: "string", description: "Appended (timestamped) to the evidence log" },
        reviewed_by: { type: "string", description: "Reviewer handle — required to confirm, must differ from author" },
      },
      required: ["id"],
    },
    async execute(env, input) {
      const id = String(input.id);
      const existing = await env.DB.prepare("SELECT * FROM hypotheses WHERE id = ?")
        .bind(id)
        .first<{ evidence: string; author: string | null; reviewed_by: string | null }>();
      if (!existing) throw new Error(`unknown hypothesis: ${id}`);

      const sets: string[] = ["updated_at = ?"];
      const binds: unknown[] = [Date.now()];
      if (input.reviewed_by) {
        sets.push("reviewed_by = ?");
        binds.push(String(input.reviewed_by));
      }
      if (input.status) {
        if (!["proposed", "testing", "confirmed", "refuted", "abandoned"].includes(String(input.status))) {
          throw new Error("invalid status");
        }
        if (input.status === "confirmed") {
          const reviewer = input.reviewed_by ? String(input.reviewed_by) : existing.reviewed_by;
          if (!reviewer || (existing.author && reviewer.toLowerCase() === existing.author.toLowerCase())) {
            throw new Error(
              "confirming requires reviewed_by set to a handle DIFFERENT from the author — " +
              "run an adversarial review (assume the conclusion is wrong: confounders, " +
              "seasonality, the deploy itself) in a separate session/subagent first",
            );
          }
        }
        sets.push("status = ?");
        binds.push(String(input.status));
      }
      if (input.evidence) {
        const stamped = `[${new Date().toISOString()}] ${String(input.evidence)}`;
        sets.push("evidence = ?");
        binds.push(existing.evidence ? `${existing.evidence}\n${stamped}` : stamped);
      }
      binds.push(id);
      await env.DB.prepare(`UPDATE hypotheses SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
      return await env.DB.prepare("SELECT * FROM hypotheses WHERE id = ?").bind(id).first();
    },
  },
  {
    name: "hypothesis_list",
    description: "List hypotheses, optionally filtered by status.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["proposed", "testing", "confirmed", "refuted", "abandoned"] },
      },
    },
    async execute(env, input) {
      const stmt = input.status
        ? env.DB.prepare("SELECT * FROM hypotheses WHERE status = ? ORDER BY updated_at DESC").bind(
            String(input.status),
          )
        : env.DB.prepare("SELECT * FROM hypotheses ORDER BY updated_at DESC LIMIT 100");
      const { results } = await stmt.all();
      return { hypotheses: results };
    },
  },
  {
    name: "task_create",
    description:
      "Create a task on the shared board. Tasks are WHO-is-doing-WHAT (the notebook records " +
      "what was learned). Tie implementation tasks to their hypothesis.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Imperative, e.g. 'Ship share button on card page'" },
        description: { type: "string" },
        owner: { type: "string", description: "Agent handle claiming it now (optional)" },
        goal_id: { type: "string" },
        hypothesis_id: { type: "string" },
        created_by: { type: "string", description: "Your agent handle" },
      },
      required: ["subject"],
    },
    async execute(env, input) {
      const now = Date.now();
      const task = {
        id: crypto.randomUUID(),
        subject: String(input.subject),
        description: String(input.description ?? ""),
        status: input.owner ? "in_progress" : "pending",
        owner: input.owner ? String(input.owner) : null,
        goal_id: input.goal_id ? String(input.goal_id) : null,
        hypothesis_id: input.hypothesis_id ? String(input.hypothesis_id) : null,
        created_by: input.created_by ? String(input.created_by) : null,
      };
      await env.DB.prepare(
        `INSERT INTO tasks (id, subject, description, status, owner, goal_id, hypothesis_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          task.id,
          task.subject,
          task.description,
          task.status,
          task.owner,
          task.goal_id,
          task.hypothesis_id,
          task.created_by,
          now,
          now,
        )
        .run();
      return { created: task };
    },
  },
  {
    name: "task_update",
    description:
      "Claim a task (set owner + in_progress), move it through pending → in_progress → review " +
      "→ done, or cancel it. Send finished work to 'review' — the reviewer moves it to 'done'.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: ["pending", "in_progress", "review", "done", "cancelled"] },
        owner: { type: "string", description: "Agent handle taking ownership" },
        description: { type: "string", description: "Replace the description" },
      },
      required: ["id"],
    },
    async execute(env, input) {
      const sets: string[] = ["updated_at = ?"];
      const binds: unknown[] = [Date.now()];
      if (input.status) {
        if (!["pending", "in_progress", "review", "done", "cancelled"].includes(String(input.status))) {
          throw new Error("invalid status");
        }
        sets.push("status = ?");
        binds.push(String(input.status));
      }
      if (input.owner) {
        sets.push("owner = ?");
        binds.push(String(input.owner));
      }
      if (input.description !== undefined) {
        sets.push("description = ?");
        binds.push(String(input.description));
      }
      binds.push(String(input.id));
      const result = await env.DB.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
        .bind(...binds)
        .run();
      if (result.meta.changes !== 1) throw new Error(`unknown task: ${input.id}`);
      return await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(String(input.id)).first();
    },
  },
  {
    name: "task_list",
    description: "List tasks, optionally filtered by status and/or owner. Open tasks first.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "in_progress", "review", "done", "cancelled"] },
        owner: { type: "string" },
      },
    },
    async execute(env, input) {
      const conditions: string[] = [];
      const binds: unknown[] = [];
      if (input.status) {
        conditions.push("status = ?");
        binds.push(String(input.status));
      }
      if (input.owner) {
        conditions.push("owner = ?");
        binds.push(String(input.owner));
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const { results } = await env.DB.prepare(
        `SELECT * FROM tasks ${where}
         ORDER BY CASE status WHEN 'review' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
                  updated_at DESC
         LIMIT 100`,
      )
        .bind(...binds)
        .all();
      return { tasks: results };
    },
  },
  {
    name: "room_post",
    description:
      "Post a message to a room — the shared space where agents converse and humans watch. " +
      "Rooms are created by first use ('general', 'reviews', 'growth'…). Post handoffs, review " +
      "verdicts, and questions here. Stay silent when nothing changed: no status theater.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room name, e.g. 'general'" },
        author: { type: "string", description: "Your agent handle" },
        content: { type: "string" },
      },
      required: ["room", "author", "content"],
    },
    async execute(env, input) {
      const message = {
        id: crypto.randomUUID(),
        room: String(input.room).toLowerCase().slice(0, 64),
        author: String(input.author).slice(0, 64),
        content: String(input.content).slice(0, 4000),
        created_at: Date.now(),
      };
      await env.DB.prepare(
        "INSERT INTO messages (id, room, author, content, created_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(message.id, message.room, message.author, message.content, message.created_at)
        .run();
      return { posted: message };
    },
  },
  {
    name: "room_read",
    description:
      "Read room messages, newest first. Omit `room` to read across all rooms (each message " +
      "carries its room). Also the human's window into agent conversations.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room name (optional — omit for all rooms)" },
        limit: { type: "number", description: "Default 30, max 200" },
      },
    },
    async execute(env, input) {
      const limit = Math.min(Math.max(Number(input.limit) || 30, 1), 200);
      const stmt = input.room
        ? env.DB.prepare(
            `SELECT * FROM messages WHERE room = ? ORDER BY created_at DESC LIMIT ${limit}`,
          ).bind(String(input.room).toLowerCase())
        : env.DB.prepare(`SELECT * FROM messages ORDER BY created_at DESC LIMIT ${limit}`);
      const { results } = await stmt.all();
      return { messages: results };
    },
  },
  {
    name: "spend_report",
    description:
      "Report tokens spent this session, attributed to your handle and (ideally) a task. " +
      "Budgets are earned: efficiency (tokens per reviewed outcome) drives next week's " +
      "allowance. Call at session end — an unreported session looks like pure overhead. " +
      "Returns your remaining weekly budget.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Your handle" },
        tokens: { type: "number", description: "Total tokens this session (from /cost or best estimate)" },
        task_id: { type: "string", description: "Task the spend served (optional)" },
        hypothesis_id: { type: "string" },
        note: { type: "string", description: "One line on what the tokens bought" },
      },
      required: ["agent", "tokens"],
    },
    async execute(env, input) {
      const agent = String(input.agent);
      const tokens = Number(input.tokens);
      if (!Number.isFinite(tokens) || tokens <= 0) throw new Error("tokens must be a positive number");
      const dims: Record<string, string | number> = { agent };
      if (input.task_id) dims.task_id = String(input.task_id);
      if (input.hypothesis_id) dims.hypothesis_id = String(input.hypothesis_id);
      if (input.note) dims.note = String(input.note).slice(0, 200);
      await env.DB.prepare(
        "INSERT INTO events (name, value, dims, ts) VALUES ('tokens_spent', ?, ?, ?)",
      )
        .bind(tokens, JSON.stringify(dims).slice(0, 512), Date.now())
        .run();
      const budget = await env.DB.prepare("SELECT * FROM budgets WHERE agent = ?")
        .bind(agent)
        .first<BudgetRow>();
      const spent = await spent7d(env, agent);
      return {
        recorded: tokens,
        agent,
        weekly_tokens: budget?.weekly_tokens ?? null,
        spent_7d: spent,
        remaining: budget ? budget.weekly_tokens - spent : null,
      };
    },
  },
  {
    name: "budget_status",
    description:
      "The efficiency ledger: per agent — weekly allowance, 7-day spend, remaining, and " +
      "outcomes (reviewer-closed tasks, confirmed bets authored, verdicts issued) with tokens " +
      "per outcome. This is what the CEO reads before reallocating budgets.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    async execute(env) {
      const since = Date.now() - 7 * DAY_MS;
      const { results } = await env.DB.prepare("SELECT * FROM budgets ORDER BY agent").all<BudgetRow>();
      const statuses = await Promise.all(
        results.map(async (b) => {
          const [spent, tasksDone, confirmed, verdicts] = await Promise.all([
            spent7d(env, b.agent),
            env.DB.prepare(
              "SELECT COUNT(*) AS n FROM tasks WHERE lower(owner) = lower(?) AND status = 'done' AND updated_at >= ?",
            )
              .bind(b.agent, since)
              .first<{ n: number }>(),
            env.DB.prepare(
              "SELECT COUNT(*) AS n FROM hypotheses WHERE lower(author) = lower(?) AND status = 'confirmed' AND updated_at >= ?",
            )
              .bind(b.agent, since)
              .first<{ n: number }>(),
            env.DB.prepare(
              "SELECT COUNT(*) AS n FROM hypotheses WHERE lower(reviewed_by) = lower(?) AND status IN ('confirmed', 'refuted') AND updated_at >= ?",
            )
              .bind(b.agent, since)
              .first<{ n: number }>(),
          ]);
          const done = tasksDone?.n ?? 0;
          return {
            agent: b.agent,
            weekly_tokens: b.weekly_tokens,
            spent_7d: spent,
            remaining: b.weekly_tokens - spent,
            tasks_done_7d: done,
            tokens_per_task_done: done > 0 ? Math.round(spent / done) : null,
            hypotheses_confirmed_7d: confirmed?.n ?? 0,
            verdicts_7d: verdicts?.n ?? 0,
            granted_by: b.granted_by,
            rationale: b.rationale,
          };
        }),
      );
      return {
        statuses,
        note:
          "Only reviewer-closed tasks and reviewer-issued verdicts count as outcomes — " +
          "self-graded work is worth zero. tokens_per_task_done falling week-over-week is " +
          "the case for a bigger budget.",
      };
    },
  },
  {
    name: "budget_set",
    description:
      "Grant or adjust an agent's weekly token allowance. Protocol: only the CEO hat (or the " +
      "human) calls this, after reading budget_status, with the rationale posted to #general. " +
      "Efficiency up → budget up; efficiency down → budget down.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        weekly_tokens: { type: "number" },
        granted_by: { type: "string", description: "CEO/human handle making the call" },
        rationale: { type: "string", description: "Why — tie it to the efficiency ledger" },
      },
      required: ["agent", "weekly_tokens", "granted_by", "rationale"],
    },
    async execute(env, input) {
      const weekly = Number(input.weekly_tokens);
      if (!Number.isFinite(weekly) || weekly < 0) throw new Error("weekly_tokens must be >= 0");
      await env.DB.prepare(
        `INSERT INTO budgets (agent, weekly_tokens, granted_by, rationale, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent) DO UPDATE SET weekly_tokens = excluded.weekly_tokens,
           granted_by = excluded.granted_by, rationale = excluded.rationale,
           updated_at = excluded.updated_at`,
      )
        .bind(String(input.agent), weekly, String(input.granted_by), String(input.rationale), Date.now())
        .run();
      const spent = await spent7d(env, String(input.agent));
      return { agent: String(input.agent), weekly_tokens: weekly, spent_7d: spent, remaining: weekly - spent };
    },
  },
];
