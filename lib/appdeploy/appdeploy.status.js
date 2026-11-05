'use strict';

/**
 * AppDeploy.ai Deployment States & 8-Step Workflow Status Tracker
 */

const { db } = require('../database');

const DEPLOYMENT_STATES = {
    NOT_CONNECTED: 'Not Connected',
    READY_TO_DEPLOY: 'Ready to Deploy',
    PREPARING: 'Preparing Application',
    BUILDING: 'Building',
    DEPLOYING: 'Deploying',
    RUNNING_QA: 'Running QA',
    SUCCESSFULLY_DEPLOYED: 'Successfully Deployed',
    DEPLOYMENT_FAILED: 'Deployment Failed'
};

const WORKFLOW_STEPS = [
    { step: 1, state: DEPLOYMENT_STATES.PREPARING, title: 'Validate Generated Application & Project Files' },
    { step: 2, state: DEPLOYMENT_STATES.PREPARING, title: 'Verify AppDeploy Account Connection & Permissions' },
    { step: 3, state: DEPLOYMENT_STATES.PREPARING, title: 'Retrieve Official AppDeploy MCP Instructions & Template' },
    { step: 4, state: DEPLOYMENT_STATES.BUILDING, title: 'Prepare Application Bundle for AppDeploy MCP' },
    { step: 5, state: DEPLOYMENT_STATES.DEPLOYING, title: 'Submit Application via Official AppDeploy MCP Integration' },
    { step: 6, state: DEPLOYMENT_STATES.RUNNING_QA, title: 'Track Deployment Progress & Run QA Checks' },
    { step: 7, state: DEPLOYMENT_STATES.SUCCESSFULLY_DEPLOYED, title: 'Verify Final Public Application URL' },
    { step: 8, state: DEPLOYMENT_STATES.DEPLOYMENT_FAILED, title: 'Diagnostics & AI-Assisted Recovery' }
];

function appendDeploymentLog({ deploymentId, ownerUsername, stepNumber, stepName, state, level = 'info', message }) {
    const now = new Date().toISOString();
    try {
        db.prepare(`
            INSERT INTO app_deployment_logs (
                deployment_id, owner_username, step_number, step_name, state, level, message, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            Number(deploymentId),
            String(ownerUsername || 'zaidashiq'),
            Number(stepNumber || 1),
            String(stepName || 'Workflow Step'),
            String(state || DEPLOYMENT_STATES.PREPARING),
            String(level || 'info'),
            String(message || ''),
            now
        );
    } catch (err) {
        console.warn('[appdeploy.status] log insert warning:', err.message);
    }
}

function updateDeploymentState(deploymentId, ownerUsername, { status, currentStep, publicUrl, mcpDeploymentId, qaFeedback, errorMessage, aiFixSuggestion }) {
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT * FROM app_deployments WHERE id = ? AND owner_username = ?').get(Number(deploymentId), String(ownerUsername));
    if (!existing) return null;

    const nextStatus = status !== undefined ? status : existing.status;
    const nextStep = currentStep !== undefined ? Number(currentStep) : existing.current_step;
    const nextUrl = publicUrl !== undefined ? publicUrl : existing.public_url;
    const nextMcpId = mcpDeploymentId !== undefined ? mcpDeploymentId : existing.mcp_deployment_id;
    const nextQa = qaFeedback !== undefined ? qaFeedback : existing.qa_feedback;
    const nextErr = errorMessage !== undefined ? errorMessage : existing.error_message;
    const nextFix = aiFixSuggestion !== undefined ? aiFixSuggestion : existing.ai_fix_suggestion;

    db.prepare(`
        UPDATE app_deployments
        SET status = ?,
            current_step = ?,
            public_url = ?,
            mcp_deployment_id = ?,
            qa_feedback = ?,
            error_message = ?,
            ai_fix_suggestion = ?,
            updated_at = ?
        WHERE id = ? AND owner_username = ?
    `).run(nextStatus, nextStep, nextUrl, nextMcpId, nextQa, nextErr, nextFix, now, Number(deploymentId), String(ownerUsername));

    return getDeploymentById(deploymentId, ownerUsername);
}

function getDeploymentById(deploymentId, ownerUsername) {
    const row = db.prepare(`
        SELECT d.*, p.name AS project_name, p.stack AS project_stack
        FROM app_deployments d
        LEFT JOIN app_projects p ON d.project_id = p.id
        WHERE d.id = ? AND d.owner_username = ?
    `).get(Number(deploymentId), String(ownerUsername));
    if (!row) return null;

    const logs = db.prepare(`
        SELECT * FROM app_deployment_logs
        WHERE deployment_id = ? AND owner_username = ?
        ORDER BY id ASC
    `).all(Number(deploymentId), String(ownerUsername));

    const versions = db.prepare(`
        SELECT id, deployment_id, project_id, version_number, public_url, status, created_at
        FROM app_deployment_versions
        WHERE project_id = ? AND owner_username = ?
        ORDER BY version_number DESC
    `).all(Number(row.project_id), String(ownerUsername));

    return {
        ...row,
        logs,
        versions
    };
}

function listDeploymentsByUser(ownerUsername, projectId = null) {
    let rows;
    if (projectId) {
        rows = db.prepare(`
            SELECT d.*, p.name AS project_name, p.stack AS project_stack, p.description AS project_description
            FROM app_deployments d
            LEFT JOIN app_projects p ON d.project_id = p.id
            WHERE d.owner_username = ? AND d.project_id = ?
            ORDER BY d.id DESC
        `).all(String(ownerUsername), Number(projectId));
    } else {
        rows = db.prepare(`
            SELECT d.*, p.name AS project_name, p.stack AS project_stack, p.description AS project_description
            FROM app_deployments d
            LEFT JOIN app_projects p ON d.project_id = p.id
            WHERE d.owner_username = ?
            ORDER BY d.id DESC
        `).all(String(ownerUsername));
    }

    return rows.map(r => {
        const logs = db.prepare(`
            SELECT * FROM app_deployment_logs
            WHERE deployment_id = ? AND owner_username = ?
            ORDER BY id ASC
        `).all(Number(r.id), String(ownerUsername));
        return { ...r, logs };
    });
}

module.exports = {
    DEPLOYMENT_STATES,
    WORKFLOW_STEPS,
    appendDeploymentLog,
    updateDeploymentState,
    getDeploymentById,
    listDeploymentsByUser
};
