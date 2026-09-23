import assert from "node:assert/strict";
import test from "node:test";
import { walk } from "../src/ast.js";
import { builtInTemplateValues, instantiateTemplateSource } from "../src/cloud-templates.js";
import { parse } from "../src/parser.js";
import { createCloudUser, json, jsonStatus, startCloudServer } from "./cloud-wiki-helpers.js";

interface TemplateResponse {
  id: string;
  title: string;
  scope: string;
  siteId?: string;
  source: string;
  variables: Array<{ name: string; required: boolean; default?: string }>;
  editable: boolean;
}

interface DocumentResponse {
  id: string;
  title: string;
  source: string;
}

const blueprint = `---
owner: {{owner}}
---

# {{title}} {id="{{title_id}}"}

::decision{id="decision" owner="{{owner}}" status="proposed"}
{{summary}}
::

Team: {{team}}
`;

test("workspace and space templates: CRUD, permissions, and blueprint variables", async () => {
  const cloud = await startCloudServer("noma-cloud-templates-");
  try {
    const admin = await createCloudUser(cloud.base, "Admin");
    const editor = await createCloudUser(cloud.base, "Editor");
    const viewer = await createCloudUser(cloud.base, "Viewer");
    const site = await json<{ id: string }>(`${cloud.base}/api/sites`, { method: "POST", token: editor.token, body: { title: "Platform", documentIds: [] } });
    await json(`${cloud.base}/api/sites/${site.id}/collaborators`, { method: "POST", token: editor.token, body: { userId: viewer.id, role: "viewer" } });

    const builtIns = await json<{ templates: TemplateResponse[] }>(`${cloud.base}/api/templates`, { token: viewer.token });
    assert.ok(builtIns.templates.some((template) => template.id === "blank" && template.scope === "built-in" && !template.editable));

    const variables = [
      { name: "owner", label: "Owner", required: true },
      { name: "summary", label: "Summary", default: "Describe the decision." },
      { name: "team", label: "Team", default: "Platform" },
    ];
    await jsonStatus(`${cloud.base}/api/templates`, 403, { method: "POST", token: editor.token, body: { scope: "workspace", name: "ADR", source: blueprint, variables } });
    const workspaceTemplate = await json<TemplateResponse>(`${cloud.base}/api/templates`, {
      method: "POST",
      token: admin.token,
      body: { scope: "workspace", name: "ADR", category: "team", source: blueprint, variables },
    });
    assert.equal(workspaceTemplate.scope, "workspace");

    await jsonStatus(`${cloud.base}/api/templates`, 403, { method: "POST", token: viewer.token, body: { scope: "site", siteId: site.id, name: "Runbook", source: "# {{title}}\n" } });
    const undeclared = await jsonStatus<{ error: string }>(`${cloud.base}/api/templates`, 400, {
      method: "POST",
      token: editor.token,
      body: { scope: "site", siteId: site.id, name: "Runbook", source: "# {{title}}\n\n{{service}}\n" },
    });
    assert.match(undeclared.error, /undeclared variables: service/);
    await jsonStatus(`${cloud.base}/api/templates`, 400, {
      method: "POST",
      token: editor.token,
      body: { scope: "site", siteId: site.id, name: "Bad", source: "# x\n", variables: [{ name: "title" }] },
    });
    const siteTemplate = await json<TemplateResponse>(`${cloud.base}/api/templates`, {
      method: "POST",
      token: editor.token,
      body: { scope: "site", siteId: site.id, name: "Runbook", source: "# {{title}}\n\nService: {{service}}\n", variables: [{ name: "service", required: true }] },
    });

    const forViewer = await json<{ templates: TemplateResponse[] }>(`${cloud.base}/api/templates?site=${site.id}`, { token: viewer.token });
    assert.ok(forViewer.templates.some((template) => template.id === siteTemplate.id && !template.editable));
    assert.ok(forViewer.templates.some((template) => template.id === workspaceTemplate.id && !template.editable));
    const unscoped = await json<{ templates: TemplateResponse[] }>(`${cloud.base}/api/templates`, { token: editor.token });
    assert.ok(!unscoped.templates.some((template) => template.id === siteTemplate.id));
    const stranger = await createCloudUser(cloud.base, "Stranger");
    await jsonStatus(`${cloud.base}/api/templates?site=${site.id}`, 403, { token: stranger.token });
    await jsonStatus(`${cloud.base}/api/templates/${siteTemplate.id}`, 403, { token: stranger.token });

    const missing = await jsonStatus<{ missing?: string[] }>(`${cloud.base}/api/sites/${site.id}/documents`, 400, {
      method: "POST",
      token: editor.token,
      body: { title: "No owner", templateId: workspaceTemplate.id, variables: {} },
    });
    assert.deepEqual(missing.missing, ["owner"]);

    const created = await json<DocumentResponse>(`${cloud.base}/api/sites/${site.id}/documents`, {
      method: "POST",
      token: editor.token,
      body: {
        title: "Adopt SQLite",
        templateId: workspaceTemplate.id,
        variables: { owner: 'Ada" status="accepted', summary: "::html\n<script>alert(1)</script>\n::", team: "# not a heading {id=\"x\"}" },
      },
    });
    const doc = parse(created.source);
    const decision = [...walk(doc)].find((node) => node.type === "directive" && node.name === "decision");
    assert.ok(decision && decision.type === "directive");
    assert.equal(decision.attrs.owner, "Ada' status='accepted");
    assert.equal(decision.attrs.status, "proposed");
    assert.equal([...walk(doc)].filter((node) => node.type === "directive" && node.name === "html").length, 0);
    assert.equal([...walk(doc)].filter((node) => node.type === "section").length, 1);
    assert.equal(doc.meta.owner, 'Ada" status="accepted');
    assert.equal(created.title, "Adopt SQLite");
    assert.match(created.source, /^# Adopt SQLite \{id="adopt-sqlite"\}$/m);

    const defaults = await json<DocumentResponse>(`${cloud.base}/api/sites/${site.id}/documents`, {
      method: "POST",
      token: editor.token,
      body: { title: "Second", templateId: workspaceTemplate.id, variables: { owner: "Bo" } },
    });
    assert.match(defaults.source, /Describe the decision\./);
    assert.match(defaults.source, /Team: Platform/);

    await jsonStatus(`${cloud.base}/api/documents`, 400, { method: "POST", token: editor.token, body: { title: "Outside", templateId: siteTemplate.id, variables: { service: "api" } } });
    const runbook = await json<DocumentResponse>(`${cloud.base}/api/sites/${site.id}/documents`, {
      method: "POST",
      token: editor.token,
      body: { title: "API runbook", templateId: siteTemplate.id, variables: { service: "api" } },
    });
    assert.match(runbook.source, /Service: api/);

    const fromPage = await json<TemplateResponse>(`${cloud.base}/api/templates`, {
      method: "POST",
      token: editor.token,
      body: { scope: "site", siteId: site.id, name: "From page", fromDocumentId: runbook.id },
    });
    assert.match(fromPage.source, /^# \{\{title\}\} \{id="\{\{title_id\}\}"\}$/m);
    assert.match(fromPage.source, /Service: api/);

    await jsonStatus(`${cloud.base}/api/templates/${siteTemplate.id}`, 403, { method: "PUT", token: viewer.token, body: { name: "Nope" } });
    const renamed = await json<TemplateResponse>(`${cloud.base}/api/templates/${siteTemplate.id}`, { method: "PUT", token: editor.token, body: { name: "Service runbook" } });
    assert.equal(renamed.title, "Service runbook");
    await jsonStatus(`${cloud.base}/api/templates/blank`, 403, { method: "DELETE", token: admin.token });
    await jsonStatus(`${cloud.base}/api/templates/${workspaceTemplate.id}`, 403, { method: "DELETE", token: editor.token });
    await json(`${cloud.base}/api/templates/${workspaceTemplate.id}`, { method: "DELETE", token: admin.token });
    await jsonStatus(`${cloud.base}/api/templates/${workspaceTemplate.id}`, 404, { token: admin.token });
  } finally {
    await cloud.close();
  }
});

test("template values cannot inject structure", () => {
  const source = `# {{title}} {id="{{title_id}}"}

{{a}}

- item {{a}}

::note{title='{{a}}' kind={{a}}}
{{a}}
::

\`\`\`
{{a}}
\`\`\`
`;
  for (const value of ["# Heading", "::html", "- list", "```", "x\n::\n# Escape", "} {id=\"hijack\"}", "1. one", "| a | b |", "> quote", "---"]) {
    const filled = instantiateTemplateSource(source, builtInTemplateValues(value, "Space", { a: value }));
    const doc = parse(filled);
    const nodes = [...walk(doc)];
    assert.equal(nodes.filter((node) => node.type === "section").length, 1, `${JSON.stringify(value)}\n${filled}`);
    assert.equal(nodes.filter((node) => node.type === "directive").length, 1, `${JSON.stringify(value)}\n${filled}`);
    assert.equal(nodes.filter((node) => node.type === "code").length, 1, `${JSON.stringify(value)}\n${filled}`);
    assert.equal(nodes.filter((node) => node.type === "list").length, 1, `${JSON.stringify(value)}\n${filled}`);
    assert.equal(nodes.find((node) => node.type === "section")?.id, builtInTemplateValues(value, "Space").title_id);
  }
});
