import { test, expect } from "bun:test";
import { integrationMcpKind } from "../src/policy/mcp-kind";
import { classifyAction } from "../src/policy/classify";
import { evaluatePolicy } from "../src/policy";

/** The Linear MCP server's real toolset (mcp.linear.app, 2026-09). */
const LINEAR_READS = [
  "extract_images",
  "get_agent_skill",
  "get_attachment",
  "get_diff",
  "get_diff_threads",
  "get_document",
  "get_issue",
  "get_issue_status",
  "get_milestone",
  "get_notifications",
  "get_project",
  "get_release",
  "get_release_note",
  "get_status_updates",
  "get_team",
  "get_template",
  "get_triage_responsibility",
  "get_user",
  "get_workspace",
  "list_agent_skills",
  "list_comments",
  "list_custom_views",
  "list_cycles",
  "list_diffs",
  "list_documents",
  "list_issue_labels",
  "list_issue_statuses",
  "list_issues",
  "list_milestones",
  "list_project_labels",
  "list_projects",
  "list_release_notes",
  "list_release_pipelines",
  "list_releases",
  "list_teams",
  "list_templates",
  "list_users",
  "search_documentation",
];
const LINEAR_WRITES = [
  "create_attachment",
  "create_attachment_from_upload",
  "create_issue_label",
  "delete_attachment",
  "delete_comment",
  "delete_diff_comment",
  "delete_status_update",
  "mark_notification",
  "merge_diff",
  "prepare_attachment_upload",
  "resolve_diff_thread",
  "restore_issue_label",
  "restore_project_label",
  "retire_issue_label",
  "retire_project_label",
  "save_comment",
  "save_diff_comment",
  "save_document",
  "save_issue",
  "save_issue_label",
  "save_milestone",
  "save_project",
  "save_project_label",
  "save_release",
  "save_release_note",
  "save_status_update",
  "share_issue",
  "submit_diff_review",
  "unshare_issue",
  "update_diff",
];

test("every real Linear tool is classified as the read or write it is", () => {
  expect(LINEAR_READS.length + LINEAR_WRITES.length).toBe(68);

  for (const t of LINEAR_READS) {
    expect({ t, kind: integrationMcpKind("linear", t, {}) }).toEqual({
      t,
      kind: "integration_read",
    });
  }

  for (const t of LINEAR_WRITES) {
    expect({ t, kind: integrationMcpKind("linear", t, {}) }).toEqual({
      t,
      kind: "integration_write",
    });
  }
});

test("twenty: catalog browsing reads; execute_tool follows its inner tool", () => {
  for (const t of [
    "get_tool_catalog",
    "learn_tools",
    "list_skills",
    "load_skills",
    "search_help_center",
    "list_object_metadata_names",
  ]) {
    expect(integrationMcpKind("twenty", t, {})).toBe("integration_read");
  }

  expect(
    integrationMcpKind("twenty", "execute_tool", {
      toolName: "find_many_people",
    })
  ).toBe("integration_read");
  expect(
    integrationMcpKind("twenty", "execute_tool", {
      toolName: "group_by_opportunities",
    })
  ).toBe("integration_read");
  expect(
    integrationMcpKind("twenty", "execute_tool", {
      toolName: "delete_one_company",
    })
  ).toBe("integration_write");
  expect(
    integrationMcpKind("twenty", "execute_tool", { toolName: "send_email" })
  ).toBe("integration_write");
  expect(integrationMcpKind("twenty", "execute_tool", {})).toBe(
    "integration_write"
  );
});

test("notion's hyphenated names and bare search/fetch are reads", () => {
  expect(integrationMcpKind("notion", "notion-search", {})).toBe(
    "integration_read"
  );
  expect(integrationMcpKind("notion", "notion-fetch", {})).toBe(
    "integration_read"
  );
  expect(integrationMcpKind("notion", "search", {})).toBe("integration_read");
  expect(integrationMcpKind("notion", "notion-create-pages", {})).toBe(
    "integration_write"
  );
  expect(integrationMcpKind("notion", "notion-update-page", {})).toBe(
    "integration_write"
  );
});

test("an unknown verb is a write, never waved through as a read", () => {
  expect(integrationMcpKind("linear", "archive_everything", {})).toBe(
    "integration_write"
  );
  expect(integrationMcpKind("linear", "getaway", {})).toBe("integration_write");
});

test("non-integration servers stay generic mcp_tool", () => {
  expect(integrationMcpKind("context7", "get-library-docs", {})).toBeNull();
  expect(
    classifyAction(
      { id: "1", name: "mcp__context7__get-library-docs", arguments: {} },
      "/w"
    ).kind
  ).toBe("mcp_tool");
});

test("classifyAction: raw Linear calls become integration kinds with the server kept", () => {
  const read = classifyAction(
    { id: "1", name: "mcp__linear__list_projects", arguments: {} },
    "/w"
  );
  const write = classifyAction(
    {
      id: "2",
      name: "mcp__linear__save_project",
      arguments: { name: "Articles" },
    },
    "/w"
  );

  expect(read).toMatchObject({ kind: "integration_read", mcpServer: "linear" });
  expect(write).toMatchObject({
    kind: "integration_write",
    mcpServer: "linear",
  });
});

test("policy: plan mode allows raw Linear reads, denies raw writes; default mode allows both", () => {
  const ctx = (mode: "plan" | "default") => ({
    mode,
    cwd: "/w",
    mcpServers: ["linear"],
    files: ["**"],
    interactive: true,
  });
  const call = (name: string) =>
    classifyAction({ id: "1", name, arguments: {} }, "/w");

  expect(
    evaluatePolicy(call("mcp__linear__list_projects"), ctx("plan")).decision
  ).toBe("allow");
  expect(
    evaluatePolicy(call("mcp__linear__save_project"), ctx("plan")).decision
  ).toBe("deny");
  expect(
    evaluatePolicy(call("mcp__linear__save_project"), ctx("default")).decision
  ).toBe("allow");
});

test("policy: an integration-named call to an UNREGISTERED server is still blocked", () => {
  const action = classifyAction(
    { id: "1", name: "mcp__linear__list_projects", arguments: {} },
    "/w"
  );
  const verdict = evaluatePolicy(action, {
    mode: "default",
    cwd: "/w",
    mcpServers: [],
    files: ["**"],
    interactive: true,
  });

  expect(verdict.decision).toBe("deny");
  expect(verdict.reason).toContain("unregistered MCP server");
});
