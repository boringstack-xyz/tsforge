import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import mermaid from "astro-mermaid";
import remarkGfm from "remark-gfm";

function rehypeAccessibleTables() {
  return (tree) => {
    const visit = (node, parent, index) => {
      if (!node || typeof node !== "object") return;
      if (
        node.type === "element" &&
        node.tagName === "table" &&
        parent &&
        !(
          parent.type === "element" &&
          parent.tagName === "div" &&
          parent.properties?.role === "region"
        )
      ) {
        const wrapper = {
          type: "element",
          tagName: "div",
          properties: {
            role: "region",
            "aria-label": "Scrollable table",
            tabIndex: 0,
            className: ["tf-table-scroll"],
          },
          children: [node],
        };
        parent.children[index] = wrapper;
        return;
      }
      if (Array.isArray(node.children)) {
        for (let i = 0; i < node.children.length; i++) {
          visit(node.children[i], node, i);
        }
      }
    };
    visit(tree, null, 0);
  };
}

export default defineConfig({
  site: "https://tsforge.dev",
  output: "static",

  markdown: {
    remarkPlugins: [remarkGfm],
    rehypePlugins: [rehypeAccessibleTables],
  },

  integrations: [
    sitemap(),
    react(),
    mermaid({
      theme: "base",
      autoTheme: true,
      mermaidConfig: {
        look: "classic",
        flowchart: { curve: "basis", padding: 26, useMaxWidth: true },
        themeVariables: {
          background: "transparent",
          primaryColor: "rgba(59, 130, 246, 0.16)",
          primaryBorderColor: "#3b82f6",
          primaryTextColor: "#f1f5f9",
          lineColor: "#60a5fa",
          textColor: "#f1f5f9",
          fontFamily:
            "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        },
      },
    }),
    starlight({
      title: "tsforge",
      description:
        "Ship full-stack TypeScript — loops until your acceptance check passes.",
      favicon: "/favicon.svg",
      customCss: [
        "./src/styles/tailwind.css",
        "./src/styles/custom.css",
        "./src/styles/landing.css",
        "./src/styles/redesign.css",
      ],
      tableOfContents: false,
      components: {
        Footer: "./src/components/Footer.astro",
        Header: "./src/components/Header.astro",
        Hero: "./src/components/Landing.astro",
        PageTitle: "./src/components/PageTitle.astro",
        Pagination: "./src/components/Pagination.astro",
        ThemeProvider: "./src/components/ThemeProvider.astro",
      },
      head: [
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" },
        },
        {
          tag: "link",
          attrs: {
            rel: "preconnect",
            href: "https://fonts.gstatic.com",
            crossorigin: true,
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Inter:wght@300;400;500;600;700&display=swap",
          },
        },
        {
          tag: "meta",
          attrs: { property: "og:type", content: "website" },
        },
        {
          tag: "meta",
          attrs: { property: "og:site_name", content: "tsforge" },
        },
        {
          tag: "meta",
          attrs: { property: "og:url", content: "https://tsforge.dev/" },
        },
        {
          tag: "meta",
          attrs: { name: "twitter:card", content: "summary_large_image" },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: "https://tsforge.dev/og-harness-board.png",
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:image",
            content: "https://tsforge.dev/og-harness-board.png",
          },
        },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/boringstack-xyz/tsforge",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/boringstack-xyz/tsforge/edit/main/apps/docs/",
      },
      lastUpdated: true,
      sidebar: [
        {
          label: "Get started",
          items: [
            { label: "Welcome", link: "/" },
            { label: "Quickstart", link: "/quickstart/" },
            { label: "How it works", link: "/big-picture/" },
          ],
        },
        {
          label: "Everyday use",
          items: [
            { label: "Set up a repo", link: "/cli/setup/" },
            { label: "Chat with your repo", link: "/cli/interactive/" },
            { label: "Drive a change to green", link: "/workflows/fix-to-green/" },
            { label: "Build a whole app", link: "/loop/greenfield/" },
            { label: "Review your changes", link: "/cli/review/" },
            { label: "Delegate to subagents", link: "/agent/delegation/" },
            { label: "Recipes", link: "/cli/recipes/" },
            { label: "Pre-edit scout", link: "/loop/scout/" },
            { label: "Map the repo", link: "/cli/map/" },
            { label: "Plan mode", link: "/cli/plan-mode/" },
          ],
        },
        {
          label: "Quality & strictness",
          items: [
            { label: "The gate", link: "/loop/gate-floor/" },
            { label: "When the gate fails", link: "/loop/validation/" },
            { label: "Tests by default", link: "/quality/tests/" },
            { label: "Stack detection", link: "/guardrails/stack-detection/" },
            { label: "Rule packs", link: "/guardrails/rule-packs/" },
            { label: "Meta-rules", link: "/guardrails/meta-rules/" },
          ],
        },
        {
          label: "Configure",
          items: [
            { label: "Models (any provider)", link: "/inference/models-json/" },
            { label: "tsforge.config.json", link: "/guardrails/config/" },
            { label: "Permissions & policy", link: "/guardrails/policy/" },
            { label: "Environment variables", link: "/reference/flags/" },
            { label: "MCP servers", link: "/integrations/mcp/" },
            { label: "Git & GitHub", link: "/integrations/git-github/" },
            { label: "Linear", link: "/integrations/linear/" },
            { label: "Notion", link: "/integrations/notion/" },
            { label: "Sentry", link: "/integrations/sentry/" },
            { label: "Web access", link: "/integrations/web-tools/" },
            { label: "Research in your Chrome", link: "/integrations/chrome/" },
            { label: "Decision memory", link: "/integrations/decision-memory/" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Commands", link: "/reference/commands/" },
            { label: "Input editor", link: "/reference/input-editor/" },
            { label: "Rule catalog", link: "/reference/rules-catalog/" },
            { label: "Roadmap", link: "/reference/roadmap/" },
          ],
        },
        {
          label: "Under the hood",
          collapsed: true,
          items: [
            { label: "Model agent", link: "/agent/model-agent/" },
            { label: "Skills and the harness", link: "/agent/skills-and-harness/" },
            { label: "File ops", link: "/edit/engine/" },
            { label: "TypeScript language server", link: "/lsp/typescript-server/" },
            { label: "Write diagnostics", link: "/uplift/write-diagnostics/" },
            { label: "Fixing bad tool calls", link: "/uplift/repair-ladder/" },
            { label: "Safer line edits", link: "/uplift/hashline/" },
            { label: "Stopping bad output early", link: "/uplift/ttsr/" },
            { label: "Learning from past runs", link: "/uplift/memory/" },
            { label: "Greenfield scaffolding", link: "/scaffold/boringstack/" },
            { label: "Phaser scaffolding", link: "/scaffold/phaser/" },
            { label: "Model adapter", link: "/inference/adapter/" },
            { label: "Token metrics", link: "/observability/metrics/" },
            { label: "Trace a run", link: "/observability/trace/" },
          ],
        },
        {
          label: "For contributors",
          collapsed: true,
          items: [
            { label: "Spec format", link: "/spec/format/" },
            { label: "Spec runner", link: "/loop/spec-runner/" },
            { label: "A/B testing (eval)", link: "/eval/ab-testing/" },
          ],
        },
        {
          label: "Internals",
          collapsed: true,
          items: [
            { label: "Overview", link: "/internals/" },
            { label: "Where do I change X?", link: "/internals/where-to-change/" },
            { label: "How a run executes", link: "/internals/control-flow/" },
            { label: "Subsystems", link: "/internals/subsystems/" },
            { label: "Adapters and seams", link: "/internals/seams/" },
          ],
        },
      ],
    }),
  ],

  vite: {
    plugins: [tailwindcss()],
    build: {
      chunkSizeWarningLimit: 700,
    },
  },
});
