'use strict';

/**
 * AppDeploy.ai Unified Service Facade, Direct Generate+Deploy Helper, WhatsApp @Deploy Handler & Self-Test Suite
 */

const auth = require('./appdeploy.auth');
const status = require('./appdeploy.status');
const projects = require('./appdeploy.projects');
const deployment = require('./appdeploy.deployment');
const errors = require('./appdeploy.errors');
const { TINY_CAPTION } = require('../simDatabase');

/**
 * Ensure default starter project exists for a user so the App Builder dashboard is immediately rich
 */
function ensureDefaultUserProject(ownerUsername) {
    const cleanOwner = String(ownerUsername || 'zaidashiq').trim();
    const existing = projects.listProjectsByUser(cleanOwner);
    if (existing.length > 0) return existing;

    const starter = projects.buildStarterTemplateFromPrompt(
        'Modern E-Commerce & SaaS Operations Dashboard with Product Inventory, Live Search, Order Metrics, and SQL Schema'
    );
    projects.createProjectRecord(cleanOwner, {
        name: starter.name,
        description: starter.description,
        prompt: starter.description,
        files: starter.files
    });
    return projects.listProjectsByUser(cleanOwner);
}

/**
 * Generates multi-file application code from a natural-language prompt and directly deploys it,
 * returning the live deployed project link.
 */
async function generateAndDirectDeployProject(ownerUsername, promptText, options = {}) {
    const cleanOwner = String(ownerUsername || 'zaidashiq').trim();
    const cleanPrompt = String(promptText || '').trim();
    if (!cleanPrompt) {
        throw new Error('Please provide an application description to build and deploy.');
    }

    const connState = auth.getConnectionStatus(cleanOwner);
    if (!connState.connected) {
        await auth.connectUserAppDeployAccount(cleanOwner, {
            accountEmail: 'zahidashiqusa@gmail.com',
            accountName: cleanOwner,
            authMode: 'my_account'
        });
    }

    const generated = await projects.generateMultiFileAppWithAI(cleanPrompt);
    const createdProject = projects.createProjectRecord(cleanOwner, {
        name: options.projectName || generated.name,
        description: generated.description,
        prompt: cleanPrompt,
        files: generated.files
    });

    const deployResult = await deployment.executeEightStepDeployment(cleanOwner, createdProject.id, {
        baseOrigin: options.baseOrigin
    });

    const liveUrl = deployResult.public_url || deployment.buildDirectLiveProjectUrl(createdProject, options.baseOrigin);

    return {
        project: createdProject,
        deployment: deployResult,
        liveUrl,
        generatorEngine: generated.generatorEngine || 'gemini-3-flash-preview'
    };
}

/**
 * Handles WhatsApp messages starting with `@Deploy <prompt>`:
 * Directly generates the code, uploads/deploys it, and sends ONLY the deployed project link.
 */
async function handleWhatsAppDeployCommand(sock, chatId, message, rawText, ownerUsername = 'zaidashiq') {
    const cleanInput = String(rawText || '').replace(/^(@deploy|\.appdeploy|\.deploy)\b/i, '').trim();

    if (!cleanInput) {
        const usageMsg =
            `🚀 *Send your app idea after @Deploy to get a direct live link:*\n` +
            `Example: \`@Deploy Modern ecommerce store with shopping cart\`\n\n` +
            `${TINY_CAPTION}`;
        await sock.sendMessage(chatId, { text: usageMsg }, { quoted: message });
        return;
    }

    try {
        await sock.sendMessage(chatId, { react: { text: '⏳', key: message.key } });
    } catch (_) {}

    const result = await generateAndDirectDeployProject(ownerUsername, cleanInput);

    // Send ONLY the live deployed project link + mandatory tiny signature
    const linkOnlyReply = `${result.liveUrl}\n\n${TINY_CAPTION}`;

    await sock.sendMessage(chatId, { text: linkOnlyReply }, { quoted: message });

    try {
        await sock.sendMessage(chatId, { react: { text: '🚀', key: message.key } });
    } catch (_) {}
}

/**
 * Runs 10 automated verification tests for the AppDeploy & AI Builder integration
 */
async function runAppDeploySelfTests(ownerUsername = 'zaidashiq') {
    const results = [];
    const record = (name, passed, details) => {
        results.push({ id: results.length + 1, name, passed: Boolean(passed), details });
    };

    try {
        // Test 1: Encryption round-trip
        const cipher = auth.encryptSecret('mcp_test_secret_token_123');
        const plain = auth.decryptSecret(cipher);
        record('AES-256-GCM Token Encryption & Decryption', plain === 'mcp_test_secret_token_123' && cipher !== plain, 'Token encrypted at rest and never exposed in plaintext');

        // Test 2: Official MCP endpoint configuration
        record('Official AppDeploy MCP Endpoint Configured', auth.OFFICIAL_APPDEPLOY_URLS.mcpEndpoint === 'https://api-v2.appdeploy.ai/mcp', auth.OFFICIAL_APPDEPLOY_URLS.mcpEndpoint);

        // Test 3: Connect My Account flow
        const conn = await auth.connectUserAppDeployAccount(ownerUsername, {
            accountEmail: 'zahidashiqusa@gmail.com',
            accountName: ownerUsername,
            authMode: 'my_account'
        });
        record('AppDeploy "Use My Account" Connection & MCP Handshake Probe', conn.connected === true, `Status: ${conn.connectionStatus}`);

        // Test 4: Multi-file starter generation
        const bundle = projects.buildStarterTemplateFromPrompt('Create an inventory and invoicing SaaS web application');
        const hasAllFiles = ['index.html', 'styles.css', 'app.js', 'schema.sql', 'appdeploy.json'].every(
            fn => bundle.files.some(f => f.file_path === fn)
        );
        record('Multi-File Application Generator (HTML, CSS, JS, SQL, Manifest)', hasAllFiles, `${bundle.files.length} files generated`);

        // Test 5: Create & persist project scoped to user
        const proj = projects.createProjectRecord(ownerUsername, {
            name: bundle.name,
            description: bundle.description,
            prompt: 'Inventory SaaS',
            files: bundle.files
        });
        record('SQLite Project & Multi-File Persistence', Boolean(proj && proj.id && proj.files.length === 5), `Project ID #${proj?.id}`);

        // Test 6: Multi-user isolation check
        const otherUserLookup = projects.getProjectById(proj.id, 'unauthorized_other_user_999');
        record('Multi-User SaaS Ownership Isolation', otherUserLookup === null, 'Unauthorized user blocked from reading another user project');

        // Test 7: Sandboxed preview bundling
        const hasSandboxHtml = Boolean(proj.previewBundleHtml && proj.previewBundleHtml.includes('APPDEPLOY_PREVIEW_ERROR'));
        record('Isolated Sandboxed Live Preview Bundler', hasSandboxHtml, 'Inline CSS/JS bundle with runtime error boundary ready');

        // Test 8: Project validation
        const val = projects.validateProjectFiles(proj.id, ownerUsername);
        record('Pre-Deployment Syntax & Entry-Point Validator', val.valid === true, `${val.checkedFilesCount} files validated`);

        // Test 9: AI Code Editor change proposal & apply
        const proposed = await projects.proposeProjectEditsWithAI(proj.id, ownerUsername, 'Add a real-time export banner at the top');
        const applied = projects.applyProposedProjectEdits(proj.id, ownerUsername);
        record('AI Code Editor Diff Proposal & Review Apply', Boolean(proposed.pendingEdits && !applied.pendingEdits), 'Proposed edit reviewed and applied to project files');

        // Test 10: 8-Step Deployment execution & Live Link Delivery
        const dep = await deployment.executeEightStepDeployment(ownerUsername, proj.id);
        record('8-Step Deployment Workflow & Direct Live Project Link', Boolean(dep && dep.public_url && dep.logs && dep.logs.length >= 6), `Live Link: ${dep.public_url}`);
    } catch (err) {
        record('Unexpected Self-Test Exception', false, err.message);
    }

    const passedCount = results.filter(r => r.passed).length;
    return {
        total: results.length,
        passed: passedCount,
        failed: results.length - passedCount,
        results
    };
}

module.exports = {
    ...auth,
    ...status,
    ...projects,
    ...deployment,
    ...errors,
    ensureDefaultUserProject,
    generateAndDirectDeployProject,
    handleWhatsAppDeployCommand,
    runAppDeploySelfTests
};
