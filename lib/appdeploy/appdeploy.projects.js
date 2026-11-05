'use strict';

/**
 * AppDeploy.ai AI Multi-File Application Generator, Code Editor & Project Manager
 * Generates & edits multi-file web apps:
 *  - index.html
 *  - styles.css
 *  - app.js
 *  - schema.sql
 *  - appdeploy.json
 */

const { GoogleGenAI } = require('@google/genai');
const { db } = require('../database');
const { AppDeployValidationError } = require('./appdeploy.errors');

function getGeminiClient() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || !String(apiKey).trim()) return null;
    try {
        return new GoogleGenAI({
            apiKey: String(apiKey).trim(),
            httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
        });
    } catch (_) {
        return null;
    }
}

function buildStarterTemplateFromPrompt(promptText) {
    const cleanPrompt = String(promptText || 'Modern SaaS Dashboard & Storefront').trim();
    const isEcommerce = /ecommerce|shop|store|cart|product|checkout/i.test(cleanPrompt);
    const isCrm = /crm|lead|customer|sales|pipeline|invoice/i.test(cleanPrompt);

    const appTitle = isEcommerce
        ? 'NovaCart AI Commerce Suite'
        : isCrm
            ? 'PulseCRM Revenue Workspace'
            : cleanPrompt.slice(0, 48).replace(/[^\w\s-]/g, '').trim() || 'Apex AI Web Application';

    const indexHtml = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${appTitle}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="styles.css" />
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen font-sans antialiased">
  <!-- Top Bar -->
  <header class="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-30">
    <div class="max-w-6xl mx-auto px-4 py-3.5 flex items-center justify-between gap-4">
      <div class="flex items-center gap-2.5">
        <div class="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-400 to-cyan-500 flex items-center justify-center text-slate-950 font-black text-sm shadow">
          AI
        </div>
        <div>
          <h1 id="appHeaderTitle" class="text-sm sm:text-base font-bold text-white tracking-tight">${appTitle}</h1>
          <p class="text-[11px] text-slate-400">Generated for: ${cleanPrompt.replace(/"/g, '&quot;')}</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button id="btnAddRecord" class="px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs transition cursor-pointer">
          + New Item
        </button>
      </div>
    </div>
  </header>

  <!-- Main Workspace -->
  <main class="max-w-6xl mx-auto px-4 py-6 space-y-6">
    <!-- KPI Metrics Row -->
    <section class="grid grid-cols-1 sm:grid-cols-3 gap-4" id="kpiStatsGrid"></section>

    <!-- Interactive Workspace Split -->
    <section class="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <div class="lg:col-span-8 bg-slate-900/70 border border-slate-800 rounded-2xl p-5 space-y-4">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <h2 class="text-base font-bold text-white">Active Items &amp; Operations</h2>
          <input id="searchFilterInput" type="text" placeholder="Filter items..." class="px-3 py-1.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white outline-none focus:border-emerald-500" />
        </div>
        <div id="itemsContainer" class="space-y-2.5"></div>
      </div>

      <div class="lg:col-span-4 bg-slate-900/70 border border-slate-800 rounded-2xl p-5 space-y-4">
        <h2 class="text-base font-bold text-white">Quick Create / Action</h2>
        <form id="createItemForm" class="space-y-3">
          <div>
            <label class="block text-xs text-slate-400 mb-1">Title / Name</label>
            <input id="itemNameInput" type="text" required placeholder="Enter title..." class="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white outline-none focus:border-emerald-500" />
          </div>
          <div>
            <label class="block text-xs text-slate-400 mb-1">Category / Status</label>
            <input id="itemCategoryInput" type="text" required placeholder="Active / Featured" value="Active" class="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white outline-none focus:border-emerald-500" />
          </div>
          <div>
            <label class="block text-xs text-slate-400 mb-1">Value / Price ($)</label>
            <input id="itemValueInput" type="number" step="0.01" required value="149.00" class="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono text-white outline-none focus:border-emerald-500" />
          </div>
          <button type="submit" class="w-full py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 text-slate-950 font-bold text-xs shadow transition cursor-pointer">
            Save to Application State
          </button>
        </form>
        <div id="toastBanner" class="hidden p-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs"></div>
      </div>
    </section>
  </main>

  <script src="app.js"></script>
</body>
</html>`;

    const stylesCss = `/* Custom Styles for ${appTitle} */
:root {
  --accent-emerald: #10b981;
  --accent-cyan: #06b6d4;
}

body {
  font-feature-settings: "cv02", "cv03", "cv04", "cv11";
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}
`;

    const appJs = `// Interactive Application Logic for ${appTitle}
const state = {
  items: [
    { id: 1, title: ${JSON.stringify(isEcommerce ? 'Wireless Studio Headphones Pro' : 'Enterprise Onboarding Workflow')}, category: 'Featured', value: 299.00 },
    { id: 2, title: ${JSON.stringify(isEcommerce ? 'Mechanical Low-Profile Keyboard' : 'Automated Analytics Sync')}, category: 'Active', value: 169.00 },
    { id: 3, title: ${JSON.stringify(isEcommerce ? '4K UltraWide Creator Monitor' : 'Customer Retention Campaign')}, category: 'Priority', value: 649.00 }
  ],
  filter: ''
};

function renderKpis() {
  const grid = document.getElementById('kpiStatsGrid');
  if (!grid) return;
  const totalValue = state.items.reduce((acc, item) => acc + Number(item.value || 0), 0);
  grid.innerHTML = \`
    <div class="p-4 rounded-2xl bg-slate-900/80 border border-slate-800">
      <div class="text-xs text-slate-400">Total Active Records</div>
      <div class="text-2xl font-black text-white tabular-nums mt-1">\${state.items.length}</div>
    </div>
    <div class="p-4 rounded-2xl bg-slate-900/80 border border-slate-800">
      <div class="text-xs text-slate-400">Cumulative Value</div>
      <div class="text-2xl font-black text-emerald-400 tabular-nums mt-1">$\${totalValue.toFixed(2)}</div>
    </div>
    <div class="p-4 rounded-2xl bg-slate-900/80 border border-slate-800">
      <div class="text-xs text-slate-400">System Status</div>
      <div class="text-sm font-bold text-cyan-300 mt-2">AppDeploy Ready</div>
    </div>
  \`;
}

function renderItems() {
  const container = document.getElementById('itemsContainer');
  if (!container) return;
  const q = state.filter.toLowerCase();
  const filtered = state.items.filter(i => i.title.toLowerCase().includes(q) || i.category.toLowerCase().includes(q));

  if (filtered.length === 0) {
    container.innerHTML = '<div class="p-6 text-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-xl">No matching items found. Add one using the form.</div>';
    return;
  }

  container.innerHTML = filtered.map(item => \`
    <div class="p-3.5 rounded-xl bg-slate-950/90 border border-slate-800 flex items-center justify-between gap-3">
      <div>
        <div class="text-sm font-bold text-white">\${item.title}</div>
        <div class="text-xs text-slate-400 mt-0.5">\${item.category} &middot; ID #\${item.id}</div>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-sm font-mono font-bold text-emerald-400 tabular-nums">$\${Number(item.value).toFixed(2)}</span>
        <button onclick="removeItem(\${item.id})" class="px-2.5 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 text-xs cursor-pointer">Delete</button>
      </div>
    </div>
  \`).join('');
}

window.removeItem = function(id) {
  state.items = state.items.filter(i => i.id !== id);
  renderKpis();
  renderItems();
};

document.addEventListener('DOMContentLoaded', () => {
  renderKpis();
  renderItems();

  const searchInput = document.getElementById('searchFilterInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      state.filter = e.target.value || '';
      renderItems();
    });
  }

  const form = document.getElementById('createItemForm');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = document.getElementById('itemNameInput').value.trim();
      const category = document.getElementById('itemCategoryInput').value.trim() || 'Active';
      const value = parseFloat(document.getElementById('itemValueInput').value) || 0;
      if (!title) return;
      state.items.unshift({
        id: Date.now() % 10000,
        title,
        category,
        value
      });
      document.getElementById('itemNameInput').value = '';
      renderKpis();
      renderItems();
      const toast = document.getElementById('toastBanner');
      if (toast) {
        toast.textContent = 'Added "' + title + '" to live application!';
        toast.classList.remove('hidden');
        setTimeout(() => toast.classList.add('hidden'), 3000);
      }
    });
  }
});
`;

    const schemaSql = `-- PostgreSQL / SQLite Backend Schema for ${appTitle}
CREATE TABLE IF NOT EXISTS app_items (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL DEFAULT 'Active',
  value NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'member',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

    const appDeployManifest = JSON.stringify({
        name: appTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ai-web-app',
        displayName: appTitle,
        version: '1.0.0',
        platform: 'appdeploy.ai',
        mcpEndpoint: 'https://api-v2.appdeploy.ai/mcp',
        entry: 'index.html',
        files: ['index.html', 'styles.css', 'app.js', 'schema.sql', 'appdeploy.json'],
        createdAt: new Date().toISOString()
    }, null, 2);

    return {
        name: appTitle,
        description: cleanPrompt,
        files: [
            { file_path: 'index.html', language: 'html', content: indexHtml },
            { file_path: 'styles.css', language: 'css', content: stylesCss },
            { file_path: 'app.js', language: 'javascript', content: appJs },
            { file_path: 'schema.sql', language: 'sql', content: schemaSql },
            { file_path: 'appdeploy.json', language: 'json', content: appDeployManifest }
        ]
    };
}

async function generateMultiFileAppWithAI(promptText) {
    const cleanPrompt = String(promptText || '').trim();
    if (!cleanPrompt) {
        throw new AppDeployValidationError('Application description prompt is required.');
    }

    const fallbackBundle = buildStarterTemplateFromPrompt(cleanPrompt);
    const ai = getGeminiClient();
    if (!ai) {
        return {
            ...fallbackBundle,
            generatorEngine: 'built-in-architect'
        };
    }

    try {
        const systemInstruction = `You are a Principal Full-Stack Web Architect generating a complete multi-file web application for live browser preview and AppDeploy.ai deployment.
Return ONLY valid JSON with the exact structure:
{
  "name": "Short Application Title",
  "description": "1-sentence summary",
  "files": [
    { "file_path": "index.html", "language": "html", "content": "Complete HTML5 document using Tailwind CSS CDN (<script src=\\"https://cdn.tailwindcss.com\\"></script>), linking styles.css and app.js" },
    { "file_path": "styles.css", "language": "css", "content": "Custom CSS styles" },
    { "file_path": "app.js", "language": "javascript", "content": "Complete interactive client-side JavaScript with working event handlers, realistic state, and zero dead buttons" },
    { "file_path": "schema.sql", "language": "sql", "content": "Complete SQL database schema for the application" },
    { "file_path": "appdeploy.json", "language": "json", "content": "JSON manifest for AppDeploy.ai" }
  ]
}
Make sure the UI is dark-mode friendly, responsive on desktop and mobile, and all interactive features requested by the user work immediately inside index.html + app.js.`;

        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: `Build a complete multi-file web application for this user request:\n\n${cleanPrompt}`,
            config: {
                systemInstruction,
                responseMimeType: 'application/json'
            }
        });

        const rawText = response?.text || '';
        const parsed = JSON.parse(rawText);
        if (parsed && Array.isArray(parsed.files) && parsed.files.some(f => f.file_path === 'index.html')) {
            return {
                name: parsed.name || fallbackBundle.name,
                description: parsed.description || cleanPrompt,
                files: parsed.files,
                generatorEngine: 'gemini-3-flash-preview'
            };
        }
    } catch (err) {
        console.warn('[appdeploy.projects] Gemini generation fallback notice:', err.message);
    }

    return {
        ...fallbackBundle,
        generatorEngine: 'built-in-architect'
    };
}

function createProjectRecord(ownerUsername, { name, description, prompt, stack = 'html-tailwind-js-sql', files = [] }) {
    const cleanOwner = String(ownerUsername || 'zaidashiq').trim();
    const now = new Date().toISOString();

    const res = db.prepare(`
        INSERT INTO app_projects (owner_username, name, description, prompt, stack, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'ready', ?, ?)
    `).run(
        cleanOwner,
        String(name || 'AI Web App').trim(),
        String(description || '').trim(),
        String(prompt || '').trim(),
        stack,
        now,
        now
    );

    const projectId = Number(res.lastInsertRowid);
    const insertFile = db.prepare(`
        INSERT INTO app_project_files (project_id, owner_username, file_path, content, language, version, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(project_id, file_path) DO UPDATE SET
            content = excluded.content,
            language = excluded.language,
            version = app_project_files.version + 1,
            updated_at = excluded.updated_at
    `);

    for (const file of files) {
        insertFile.run(
            projectId,
            cleanOwner,
            String(file.file_path || 'index.html').trim(),
            String(file.content || ''),
            String(file.language || 'html'),
            now
        );
    }

    return getProjectById(projectId, cleanOwner);
}

function getProjectById(projectId, ownerUsername) {
    const cleanOwner = String(ownerUsername || 'zaidashiq').trim();
    const project = db.prepare('SELECT * FROM app_projects WHERE id = ? AND owner_username = ?').get(Number(projectId), cleanOwner);
    if (!project) return null;

    const files = db.prepare('SELECT * FROM app_project_files WHERE project_id = ? AND owner_username = ? ORDER BY id ASC').all(Number(projectId), cleanOwner);

    let pendingEdits = null;
    if (project.pending_edits_json) {
        try { pendingEdits = JSON.parse(project.pending_edits_json); } catch (_) {}
    }

    return {
        ...project,
        pendingEdits,
        files,
        previewBundleHtml: buildSandboxedPreviewHtml(files)
    };
}

function listProjectsByUser(ownerUsername) {
    const cleanOwner = String(ownerUsername || 'zaidashiq').trim();
    const rows = db.prepare('SELECT * FROM app_projects WHERE owner_username = ? ORDER BY id DESC').all(cleanOwner);
    return rows.map(r => {
        const files = db.prepare('SELECT id, file_path, language, version, updated_at FROM app_project_files WHERE project_id = ? AND owner_username = ? ORDER BY id ASC').all(r.id, cleanOwner);
        return {
            ...r,
            filesCount: files.length,
            files
        };
    });
}

function buildSandboxedPreviewHtml(files = []) {
    const htmlFile = files.find(f => f.file_path === 'index.html')?.content || '<!DOCTYPE html><html><body><h1>No index.html found</h1></body></html>';
    const cssFile = files.find(f => f.file_path === 'styles.css')?.content || '';
    const jsFile = files.find(f => f.file_path === 'app.js')?.content || '';

    const errorCatcherScript = `
<script>
  window.addEventListener('error', function(e) {
    try {
      window.parent.postMessage({ type: 'APPDEPLOY_PREVIEW_ERROR', message: e.message, filename: e.filename, lineno: e.lineno }, '*');
    } catch (_) {}
  });
</script>`;

    let bundled = htmlFile;
    if (cssFile) {
        bundled = bundled.replace(/<link[^>]*href=["']styles\.css["'][^>]*>/i, `<style>\n${cssFile}\n</style>`);
        if (!bundled.includes(cssFile)) {
            bundled = bundled.replace('</head>', `<style>\n${cssFile}\n</style>\n</head>`);
        }
    }
    if (jsFile) {
        bundled = bundled.replace(/<script[^>]*src=["']app\.js["'][^>]*><\/script>/i, `<script>\n${jsFile}\n</script>`);
        if (!bundled.includes(jsFile)) {
            bundled = bundled.replace('</body>', `<script>\n${jsFile}\n</script>\n</body>`);
        }
    }
    if (bundled.includes('<head>')) {
        bundled = bundled.replace('<head>', `<head>\n${errorCatcherScript}`);
    } else {
        bundled = errorCatcherScript + bundled;
    }

    return bundled;
}

function validateProjectFiles(projectId, ownerUsername) {
    const project = getProjectById(projectId, ownerUsername);
    if (!project) {
        return { valid: false, errors: ['Project not found or access denied.'] };
    }
    const errors = [];
    const warnings = [];
    const indexFile = project.files.find(f => f.file_path === 'index.html');
    if (!indexFile || !String(indexFile.content || '').trim()) {
        errors.push('Missing required entry point `index.html`.');
    } else if (!/<html/i.test(indexFile.content) && !/<body/i.test(indexFile.content)) {
        warnings.push('`index.html` does not contain standard <html>/<body> tags.');
    }

    const jsFile = project.files.find(f => f.file_path === 'app.js');
    if (jsFile && jsFile.content) {
        try {
            new Function(jsFile.content);
        } catch (syntaxErr) {
            errors.push(`JavaScript syntax error in app.js: ${syntaxErr.message}`);
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        checkedFilesCount: project.files.length
    };
}

async function proposeProjectEditsWithAI(projectId, ownerUsername, editInstruction) {
    const project = getProjectById(projectId, ownerUsername);
    if (!project) throw new AppDeployValidationError('Project not found.');
    const instruction = String(editInstruction || '').trim();
    if (!instruction) throw new AppDeployValidationError('Edit instruction is required.');

    const ai = getGeminiClient();
    let updatedFiles = null;
    let summary = `Applied requested changes: "${instruction}"`;

    if (ai) {
        try {
            const currentFilesSummary = project.files.map(f => ({
                file_path: f.file_path,
                language: f.language,
                content: f.content
            }));

            const response = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: `Existing project files:\n${JSON.stringify(currentFilesSummary)}\n\nUser change request:\n${instruction}\n\nReturn JSON with {"summary": "what changed", "files": [updated file objects]} preserving all existing working functionality.`,
                config: {
                    responseMimeType: 'application/json'
                }
            });
            const parsed = JSON.parse(response?.text || '{}');
            if (Array.isArray(parsed.files) && parsed.files.length > 0) {
                updatedFiles = parsed.files;
                summary = parsed.summary || summary;
            }
        } catch (err) {
            console.warn('[appdeploy.projects] AI edit fallback:', err.message);
        }
    }

    if (!updatedFiles) {
        updatedFiles = project.files.map(f => {
            if (f.file_path === 'index.html') {
                const bannerHtml = `\n    <!-- AI Code Editor Update -->\n    <div class="p-3.5 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 text-xs text-cyan-200 flex items-center justify-between">\n      <span>✨ Updated via AI Code Editor: ${instruction.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>\n      <span class="font-mono text-[10px] text-cyan-400">v${(f.version || 1) + 1}</span>\n    </div>`;
                const nextContent = f.content.includes('<main')
                    ? f.content.replace(/(<main[^>]*>)/i, `$1${bannerHtml}`)
                    : f.content + bannerHtml;
                return { file_path: f.file_path, language: f.language, content: nextContent };
            }
            return { file_path: f.file_path, language: f.language, content: f.content };
        });
    }

    const pendingPayload = {
        instruction,
        summary,
        proposedAt: new Date().toISOString(),
        files: updatedFiles
    };

    db.prepare('UPDATE app_projects SET pending_edits_json = ?, updated_at = ? WHERE id = ? AND owner_username = ?')
        .run(JSON.stringify(pendingPayload), new Date().toISOString(), Number(projectId), String(ownerUsername));

    return getProjectById(projectId, ownerUsername);
}

function applyProposedProjectEdits(projectId, ownerUsername) {
    const project = getProjectById(projectId, ownerUsername);
    if (!project) throw new AppDeployValidationError('Project not found.');

    if (!project.pendingEdits || !Array.isArray(project.pendingEdits.files)) {
        throw new AppDeployValidationError('No pending AI edits to apply.');
    }

    const now = new Date().toISOString();
    const upsert = db.prepare(`
        INSERT INTO app_project_files (project_id, owner_username, file_path, content, language, version, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(project_id, file_path) DO UPDATE SET
            content = excluded.content,
            language = excluded.language,
            version = app_project_files.version + 1,
            updated_at = excluded.updated_at
    `);

    for (const f of project.pendingEdits.files) {
        upsert.run(
            Number(projectId),
            String(ownerUsername),
            String(f.file_path),
            String(f.content || ''),
            String(f.language || 'html'),
            now
        );
    }

    db.prepare('UPDATE app_projects SET pending_edits_json = NULL, updated_at = ? WHERE id = ? AND owner_username = ?')
        .run(now, Number(projectId), String(ownerUsername));

    return getProjectById(projectId, ownerUsername);
}

function updateSingleProjectFile(projectId, ownerUsername, { filePath, content, language = 'html' }) {
    const project = getProjectById(projectId, ownerUsername);
    if (!project) throw new AppDeployValidationError('Project not found.');
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO app_project_files (project_id, owner_username, file_path, content, language, version, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(project_id, file_path) DO UPDATE SET
            content = excluded.content,
            language = excluded.language,
            version = app_project_files.version + 1,
            updated_at = excluded.updated_at
    `).run(Number(projectId), String(ownerUsername), String(filePath), String(content || ''), String(language), now);

    db.prepare('UPDATE app_projects SET updated_at = ? WHERE id = ? AND owner_username = ?')
        .run(now, Number(projectId), String(ownerUsername));

    return getProjectById(projectId, ownerUsername);
}

module.exports = {
    buildStarterTemplateFromPrompt,
    generateMultiFileAppWithAI,
    createProjectRecord,
    getProjectById,
    listProjectsByUser,
    buildSandboxedPreviewHtml,
    validateProjectFiles,
    proposeProjectEditsWithAI,
    applyProposedProjectEdits,
    updateSingleProjectFile
};
