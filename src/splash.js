const chalk = require("chalk");
const { version } = require("../package.json");

const mint = chalk.hex("#7dffc3");
const mute = chalk.hex("#6f6860");
const ink = chalk.white;
const dim = chalk.hex("#8a847c");

function strip(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function padVisible(line, width) {
  const extra = width - strip(line).length;
  return extra > 0 ? line + " ".repeat(extra) : line;
}

const ART = [
  "            .:-=++++=-:.            ",
  "        :=*%@@@@@@@@@@@@%*=:        ",
  "     .+%@@@@@*=-:..:-=*%@@@@@+:     ",
  "    +@@@@@+.            .+@@@@@+    ",
  "   *@@@@+      .SM.       =@@@@#   ",
  "   @@@@%                   %@@@@   ",
  "   #@@@@=      ----       +@@@@#   ",
  "    +@@@@@=.            .+@@@@@+    ",
  "     :+@@@@@@*=-::::-=*%@@@@@+:     ",
  "        :=*%@@@@@@@@@@@@%*=:        ",
  "            .:-=++++=-:.            ",
];

function columns(left, right, gap = 6) {
  const width = Math.max(...left.map((l) => strip(l).length));
  const rows = Math.max(left.length, right.length);
  const out = [];
  for (let i = 0; i < rows; i++) {
    const L = padVisible(left[i] || "", width);
    const R = right[i] || "";
    out.push(`  ${L}${" ".repeat(gap)}${R}`);
  }
  return out;
}

function splash({ names = 0, saved = 0, open = 0, threads = 5, queued = 0 } = {}) {
  const right = [
    "",
    mint.bold("SessionManagerPro"),
    ink("Persistent Chromium sessions"),
    mute(`v${version}`),
    "",
    mute("--------------------------------"),
    "",
    ink("Get started"),
    mint("> ") + ink("Custom name"),
    ink("  From account names"),
    ink("  Open saved sessions"),
    ink("  View saved sessions"),
    "",
    mute("view all commands in the menu"),
    "",
    mute(`${names} names   ${saved} saved   ${open}/${threads} threads   ${queued} queued`),
  ];
  console.log();
  for (const line of columns(ART.map((l) => ink(l)), right)) {
    console.log(line);
  }
  console.log();
}

function rule(label = "") {
  if (!label) return mute("  --------------------------------");
  return mute(`  -- ${label} ${"-".repeat(Math.max(4, 24 - label.length))}`);
}

module.exports = { splash, mint, mute, ink, dim, rule, strip };
