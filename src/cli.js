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
const { splash, mint, mute, ink, dim, rule } = require("./splash");

const live = new Map();
const queue = [];
let threadLimit = 5;
let launchUrl;
let filling = false;
let stopping = false;

function printBlock(text) {
  for (const line of String(text).split("\n")) console.log(`  ${line}`);
}

function button(label, accent = false) {
  return accent ? mint("> ") + ink(label) : ink("  " + label);
}

function proxyLabel(p) {
  return `${p.host}:${p.port}`;
}

function notice(msg, color = mint) {
  console.log();
  console.log(`  ${color(msg)}`);
  console.log();
}

function banner() {
  console.log();
  console.log(`  ${mint.bold("SessionManagerPro")}  ${mute(`v${require("../package.json").version}`)}`);
  console.log(
    `  ${mute(`${parseCsvAccounts().length} names`)}   ${mute(`${listSessions().length} saved`)}   ${mint(`${live.size}/${threadLimit} threads`)}   ${mute(`${queue.length} queued`)}`,
  );
  console.log(rule());
  console.log();
}

function sessionTable(rows) {
  const table = new Table({
    head: [
      mint.bold("Name"),
      mint.bold("Result"),
      ink.bold("Proxy"),
      ink.bold("Chrome"),
      mute("Reason"),
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
    console.log(mint(`  opened  ${name}  ${live.size}/${threadLimit} live  ${queue.length} queued`));
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
    message: mint("Thread count") + dim("  (max open at once)"),
    default: Math.min(names.length, threadLimit, 5),
    min: 1,
    max: Math.max(names.length, 1),
    required: true,
  });
  const url = await input({
    message: mint("Open URL") + dim("  (blank = last tabs)"),
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
          ? mint("Name 1")
          : mint(`Name ${names.length + 1}`) + dim("  (blank to finish)"),
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
    message: mint("Account names"),
    choices: [
      { name: `Pick names  ${chalk.dim(`(${names.length})`)}`, value: "pick" },
      { name: "Use all names", value: "all" },
    ],
  });
  const picked =
    mode === "all"
      ? names
      : await checkbox({
          message: mint("Select names") + dim("  (space, a = all)"),
          required: true,
          pageSize: 14,
          choices: names.map((name) => {
            const open = live.has(name);
            const saved = getSession(name);
            const tag = open
              ? chalk.green("open")
              : saved
                ? mint("saved")
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
    message: mint("Saved sessions") + dim("  (space, a = all)"),
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
  printBlock(sessionTable(rows));
  console.log();
}

async function editCsv() {
  const { input } = await prompts();
  openSessionCsv();
  notice("CSV opened — edit, save, then press enter", mute);
  await input({ message: mint("Press enter to sync") });
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
    message: mint("Close which?"),
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
    message: mint("Delete which?"),
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
      message: ink("Get started"),
      pageSize: 16,
      choices: [
        new Separator(rule("launch")),
        { name: button("Custom name", true), value: "custom" },
        { name: button("From account names"), value: "names" },
        { name: button("Open saved sessions"), value: "saved", disabled: listSessions().length ? false : "none" },
        new Separator(rule("sessions")),
        { name: button("View saved sessions"), value: "view" },
        { name: button("Edit sessions CSV"), value: "csv" },
        new Separator(rule("manage")),
        { name: button("Close open browsers"), value: "close", disabled: live.size ? false : "none open" },
        { name: button("Delete sessions"), value: "delete", disabled: listSessions().length ? false : "none" },
        new Separator(rule()),
        { name: button("Exit"), value: "exit" },
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
    splash({
      names: parseCsvAccounts().length,
      saved: listSessions().length,
      open: live.size,
      threads: threadLimit,
      queued: queue.length,
    });
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
