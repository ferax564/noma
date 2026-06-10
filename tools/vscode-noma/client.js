const { workspace } = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");

let client;

function serverCommand() {
  const configured = workspace.getConfiguration("noma").get("lsp.path", "").trim();
  if (configured) {
    const [command, ...args] = configured.split(/\s+/);
    return { command, args };
  }
  return { command: "npx", args: ["-y", "@ferax564/noma-lsp"] };
}

async function activate(context) {
  const { command, args } = serverCommand();
  const serverOptions = {
    command,
    args,
    options: { shell: process.platform === "win32" },
  };
  const clientOptions = {
    documentSelector: [{ scheme: "file", language: "noma" }],
    synchronize: { fileEvents: workspace.createFileSystemWatcher("**/*.noma") },
  };
  client = new LanguageClient("nomaLsp", "Noma Language Server", serverOptions, clientOptions);
  await client.start();
  context.subscriptions.push(client);
}

function deactivate() {
  return client ? client.stop() : undefined;
}

module.exports = { activate, deactivate };
