const chalk = require("chalk");
const ora = require("ora");
const Table = require("cli-table3");
const {
  listSessions,
  deleteSession,
  parseCsvAccounts,
  ensureSessions,
  getSession,
  openSession,
  saveSessionPatch,
  syncSheetEdits,
} = require("./manager");
const { openSessionCsv } = require("./sheet");

const live = new Map();
const queue = [];
let threadLimit = 5;
let launchUrl;
let filling = false;
let stopping = false;

function strip(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function termW() {
  return process.stdout.columns || 80;
}

function center(line, w = termW()) {
  const pad = Math.max(0, Math.floor((w - strip(line).length) / 2));
  return " ".repeat(pad) + line;
}

function printCentered(text) {
  for (const line of String(text).split("\n")) console.log(center(line));
}

function boxLines(lines, color = chalk.cyan, width = 52) {
  const inner = width - 2;
  const fit = (line) => {
    const vis = strip(line).length;
    const pad = Math.max(0, inner - vis);
    const left = Math.floor(pad / 2);
    return " ".repeat(left) + line + " ".repeat(pad - left);
  };
  return [
    color("╔" + "═".repeat(inner) + "╗"),
    ...lines.map((line) => color("║") + fit(line) + color("║")),
    color("╚" + "═".repeat(inner) + "╝"),
  ];
}

function bar(label, color = chalk.gray, width = 52) {
  const tag = ` ${label} `;
  const side = Math.max(3, Math.floor((width - strip(tag).length) / 2));
  return color("─".repeat(side) + tag + "─".repeat(side));
}

function button(label, color = chalk.cyan) {
  const text = `  ${label.padEnd(24)}`;
  return color("│") + color.bold(text) + color("│");
}

function proxyLabel(p) {
  return `${p.host}:${p.port}`;
}

function notice(msg, color = chalk.yellow) {
  printCentered("");
  printCentered(boxLines([color.bold(msg)], color, 48).join("\n"));
  printCentered("");
}

function banner() {
  const names = parseCsvAccounts().length;
  const saved = listSessions().length;
  const stats =
    chalk.magenta.bold(`${names} names`) +
    chalk.gray("   ·   ") +
    chalk.cyan.bold(`${saved} saved`) +
    chalk.gray("   ·   ") +
    chalk.green.bold(`${live.size}/${threadLimit} threads`) +
    chalk.gray("   ·   ") +
    chalk.yellow.bold(`${queue.length} queued`);
  printCentered("");
  printCentered(
    boxLines(
      [
        chalk.white.bold("SESSION MANAGER"),
        chalk.gray("sticky proxy  ·  fingerprint  ·  profile"),
        stats,
      ],
      chalk.cyan,
      58,
    ).join("\n"),
  );
  printCentered("");
}

function sessionTable(rows) {
  const table = new Table({
    head: [
      chalk.blue.bold("Name"),
      chalk.green.bold("Result"),
      chalk.yellow.bold("Proxy"),
      chalk.magenta.bold("Chrome"),
      chalk.white.bold("Reason"),
    ],
    style: { head: [], border: ["gray"] },
    wordWrap: true,
    colWidths: [34, 10, 24, 8, 36],
  });
  for (const s of rows) {
    const result = s.lastResult?.status;
    const resultCell = live.has(s.id)
      ? chalk.green.bold("open")
      : result === "success"
        ? chalk.green("success")
        : result === "error"
          ? chalk.red.bold("error")
          : chalk.dim("saved");
    table.push([
      chalk.white.bold(s.email || s.id),
      resultCell,
      chalk.yellow(proxyLabel(s.proxy)),
      chalk.magenta(s.fingerprint.chromeVersion.split(".")[0]),
      chalk.dim(s.lastResult?.reason || "—"),
    ]);
  }
  return table.toString();
}

async function prompts() {
  return import("@inquirer/prompts");
}

async function markResult(id, status, reason) {
  try {
    await saveSessionPatch(id, {
      lastResult: { status, reason, at: new Date().toISOString() },
    });
  } catch {
    // session may already be gone
  }
}

function watchHandle(handle) {
  handle.closedByUser = false;
  handle.error = null;
  const flag = (why) => {
    if (!handle.error) handle.error = why;
  };
  handle.page?.on("error", (err) => flag(err.message || "page crashed"));
  handle.page?.on("close", () => {});
  const proc = handle.browser.process?.();
  if (proc) {
    proc.on("exit", (code, signal) => {
      if (code && code !== 0) flag(`Chrome exit code ${code}${signal ? ` ${signal}` : ""}`);
    });
  }
  handle.browser.once("disconnected", () => {
    live.delete(handle.id);
    const status = handle.closedByUser || !handle.error ? "success" : "error";
    const reason = handle.closedByUser
      ? "closed by user"
      : handle.error || "closed by user";
    markResult(handle.id, status, reason);
    if (status === "error") {
      console.log(chalk.red(`  error  ${handle.id}  ${reason}`));
    } else {
      console.log(chalk.green(`  success  ${handle.id}  ${reason}`));
    }
    fillPool();
  });
}

async function startOne(name) {
  try {
    await ensureSessions([name]);
    const handle = await openSession(name, { url: launchUrl });
    await markResult(name, "running", "");
    watchHandle(handle);
    live.set(name, handle);
    console.log(chalk.cyan(`  opened  ${name}  ${live.size}/${threadLimit} live  ${queue.length} queued`));
  } catch (err) {
    const reason = err.message || String(err);
    await markResult(name, "error", reason);
    console.log(chalk.red(`  error  ${name}  ${reason}`));
  }
}

async function fillPool() {
  if (stopping || filling) return;
  filling = true;
  try {
    const jobs = [];
    while (live.size + jobs.length < threadLimit && queue.length) {
      const name = queue.shift();
      if (!name || live.has(name)) continue;
      jobs.push(startOne(name));
    }
    await Promise.all(jobs);
  } finally {
    filling = false;
    if (!stopping && live.size < threadLimit && queue.length) fillPool();
  }
}

async function launch(names) {
  names = [...new Set(names)].filter((n) => n && !live.has(n) && !queue.includes(n));
  if (!names.length) {
    notice("Nothing to open");
    return;
  }
  const { number, input } = await prompts();
  threadLimit = await number({
    message: chalk.cyan("Thread count") + chalk.dim("  (max open at once)"),
    default: Math.min(names.length, threadLimit, 5),
    min: 1,
    max: Math.max(names.length, 1),
    required: true,
  });
  const url = await input({
    message: chalk.cyan("Open URL") + chalk.dim("  (blank = last tabs)"),
    default: "",
  });
  launchUrl = url.trim() || undefined;
  queue.push(...names);
  const spinner = ora({ text: `Starting ${threadLimit} thread${threadLimit === 1 ? "" : "s"}`, color: "cyan" }).start();
  await fillPool();
  spinner.succeed(
    chalk.green.bold(`${live.size} open`) +
      chalk.dim(`  ·  ${queue.length} waiting  ·  cap ${threadLimit}`),
  );
}

async function launchCustom() {
  const { input } = await prompts();
  const names = [];
  while (true) {
    const line = await input({
      message:
        names.length === 0
          ? chalk.cyan("Name 1")
          : chalk.cyan(`Name ${names.length + 1}`) + chalk.dim("  (blank to finish)"),
      required: names.length === 0,
      default: "",
    });
    const name = String(line || "").trim();
    if (!name) break;
    names.push(name);
  }
  if (!names.length) {
    notice("No names entered");
    return;
  }
  await launch(names);
}

async function launchFromNames() {
  const names = parseCsvAccounts();
  if (!names.length) {
    notice("No profile names in AccountFile.csv");
    return;
  }
  const { checkbox, select } = await prompts();
  const mode = await select({
    message: chalk.cyan("Account names"),
    choices: [
      { name: `Pick names  ${chalk.dim(`(${names.length})`)}`, value: "pick" },
      { name: "Use all names", value: "all" },
    ],
  });
  const picked =
    mode === "all"
      ? names
      : await checkbox({
          message: chalk.cyan("Select names") + chalk.dim("  (space, a = all)"),
          required: true,
          pageSize: 14,
          choices: names.map((name) => {
            const open = live.has(name);
            const saved = getSession(name);
            const tag = open
              ? chalk.green("open")
              : saved
                ? chalk.cyan("saved")
                : chalk.dim("new");
            return { name: `${name}  ${tag}`, value: name, disabled: open ? "already open" : false };
          }),
        });
  await launch(picked);
}

async function openSaved() {
  const rows = listSessions().filter((s) => !live.has(s.id));
  if (!rows.length) {
    notice("No saved sessions to open");
    return;
  }
  const { checkbox } = await prompts();
  const names = await checkbox({
    message: chalk.cyan("Saved sessions") + chalk.dim("  (space, a = all)"),
    required: true,
    pageSize: 14,
    choices: rows.map((s) => ({
      name: `${chalk.white.bold(s.email || s.id)}  ${chalk.dim(proxyLabel(s.proxy))}`,
      value: s.id,
    })),
  });
  await launch(names);
}

async function viewSessions() {
  const rows = listSessions();
  if (!rows.length) {
    notice("No saved sessions yet");
    return;
  }
  printCentered(sessionTable(rows));
  printCentered("");
}

async function editCsv() {
  const { input } = await prompts();
  openSessionCsv();
  printCentered(
    boxLines(
      [chalk.yellow.bold("CSV opened"), chalk.dim("Edit, save, then press enter")],
      chalk.yellow,
      48,
    ).join("\n"),
  );
  await input({ message: chalk.cyan("Press enter to sync") });
  const sync = await syncSheetEdits();
  notice(`Synced  +${sync.created} new  ~${sync.updated} updated`, chalk.green);
}

async function closeRunning() {
  if (!live.size) {
    notice("Nothing open");
    return;
  }
  const { checkbox } = await prompts();
  const ids = await checkbox({
    message: chalk.cyan("Close which?"),
    required: true,
    choices: [...live.keys()].map((id) => ({ name: id, value: id })),
  });
  const spinner = ora({ text: "Saving cookies", color: "yellow" }).start();
  for (const id of ids) {
    const handle = live.get(id);
    if (!handle) continue;
    handle.closedByUser = true;
    await handle.close().catch(() => {});
  }
  spinner.succeed(chalk.green.bold(`Closed ${ids.length}  ·  next in queue will start`));
}

async function removeSessions() {
  const rows = listSessions().filter((s) => !live.has(s.id));
  if (!rows.length) {
    notice("Nothing to delete");
    return;
  }
  const { checkbox, confirm } = await prompts();
  const ids = await checkbox({
    message: chalk.cyan("Delete which?"),
    required: true,
    pageSize: 14,
    choices: rows.map((s) => ({ name: s.email || s.id, value: s.id })),
  });
  const ok = await confirm({
    message: chalk.red(`Delete ${ids.length} profile${ids.length === 1 ? "" : "s"}?`),
    default: false,
  });
  if (!ok) return;
  for (const id of ids) await deleteSession(id);
  notice(`Deleted ${ids.length}`, chalk.green);
}

async function exitApp() {
  if (!live.size) return true;
  const { confirm } = await prompts();
  const close = await confirm({
    message: chalk.yellow(`Save cookies and close ${live.size} browser${live.size === 1 ? "" : "s"}?`),
    default: true,
  });
  if (!close) return false;
  stopping = true;
  queue.length = 0;
  for (const handle of live.values()) {
    handle.closedByUser = true;
    await handle.close().catch(() => {});
  }
  live.clear();
  return true;
}

async function loop() {
  const { select, Separator } = await prompts();
  while (true) {
    const sync = await syncSheetEdits();
    if (sync.created || sync.updated) {
      notice(`CSV sync  +${sync.created} new  ~${sync.updated} updated`, chalk.green);
    }
    banner();
    const action = await select({
      message: chalk.white.bold("select an option"),
      pageSize: 16,
      choices: [
        new Separator(bar("LAUNCH", chalk.cyan, 30)),
        { name: button("Custom name", chalk.cyan), value: "custom" },
        { name: button("From account names", chalk.cyan), value: "names" },
        { name: button("Open saved sessions", chalk.cyan), value: "saved", disabled: listSessions().length ? false : "none" },
        new Separator(bar("SESSIONS", chalk.blue, 30)),
        { name: button("View saved sessions", chalk.blue), value: "view" },
        { name: button("Edit sessions CSV", chalk.yellow), value: "csv" },
        new Separator(bar("MANAGE", chalk.magenta, 30)),
        { name: button("Close open browsers", chalk.magenta), value: "close", disabled: live.size ? false : "none open" },
        { name: button("Delete sessions", chalk.red), value: "delete", disabled: listSessions().length ? false : "none" },
        new Separator(bar("", chalk.gray, 30)),
        { name: button("Exit", chalk.white), value: "exit" },
      ],
    });

    if (action === "custom") await launchCustom();
    else if (action === "names") await launchFromNames();
    else if (action === "saved") await openSaved();
    else if (action === "view") await viewSessions();
    else if (action === "csv") await editCsv();
    else if (action === "close") await closeRunning();
    else if (action === "delete") await removeSessions();
    else if (action === "exit" && (await exitApp())) return;
  }
}

async function run() {
  try {
    await loop();
  } catch (err) {
    if (err?.name === "ExitPromptError") {
      if (live.size) notice("Browsers left running", chalk.dim);
      return;
    }
    console.error(chalk.red(err.message || err));
    process.exitCode = 1;
  }
}

module.exports = { run };
