'use strict';

/**
 * AppDeploy.ai Structured Error & Diagnostics Module
 * Official Endpoint: https://api-v2.appdeploy.ai/mcp
 */

class AppDeployError extends Error {
    constructor(message, code = 'APPDEPLOY_ERROR', statusCode = 400, details = {}) {
        super(message);
        this.name = 'AppDeployError';
        this.code = code;
        this.statusCode = statusCode;
        this.details = details || {};
    }
}

class AppDeployAuthError extends AppDeployError {
    constructor(message, details = {}) {
        super(message, 'APPDEPLOY_AUTH_ERROR', 401, details);
        this.name = 'AppDeployAuthError';
    }
}

class AppDeployMcpError extends AppDeployError {
    constructor(message, details = {}) {
        super(message, 'APPDEPLOY_MCP_ERROR', 502, details);
        this.name = 'AppDeployMcpError';
    }
}

class AppDeployValidationError extends AppDeployError {
    constructor(message, details = {}) {
        super(message, 'APPDEPLOY_VALIDATION_ERROR', 422, details);
        this.name = 'AppDeployValidationError';
    }
}

function parseMcpHttpFailure(httpStatus, responseText, headers = {}) {
    const wwwAuth = headers['www-authenticate'] || headers['WWW-Authenticate'] || '';
    if (httpStatus === 401 || httpStatus === 403) {
        return {
            code: 'MCP_OAUTH_REQUIRED',
            summary: 'AppDeploy MCP endpoint (https://api-v2.appdeploy.ai/mcp) returned HTTP ' + httpStatus + '. Official AppDeploy MCP requires an active user OAuth Bearer token or authorized MCP session.',
            wwwAuthenticate: wwwAuth,
            remediation: 'Connect your AppDeploy account in AppDeploy Integration ("Use My Account") and provide an active AppDeploy MCP session/bearer token or complete account verification.'
        };
    }
    if (httpStatus === 404 || httpStatus === 405) {
        return {
            code: 'MCP_TRANSPORT_MISMATCH',
            summary: `AppDeploy MCP endpoint returned HTTP ${httpStatus}. Remember that https://api-v2.appdeploy.ai/mcp is a Model Context Protocol (JSON-RPC 2.0 / Streamable HTTP) endpoint, not a standard REST API.`,
            remediation: 'Ensure requests use JSON-RPC 2.0 method calls (initialize, tools/list, tools/call) with Accept: application/json, text/event-stream.'
        };
    }
    return {
        code: `MCP_HTTP_${httpStatus || 'ERR'}`,
        summary: responseText ? String(responseText).slice(0, 300) : `HTTP ${httpStatus} from AppDeploy MCP server`,
        remediation: 'Check your network connectivity or verify your AppDeploy MCP account token.'
    };
}

function generateDiagnosticFixSuggestion(errorMessage, projectFiles = []) {
    const msg = String(errorMessage || '');
    const hasHtml = projectFiles.some(f => f.file_path === 'index.html');
    if (!hasHtml) {
        return 'Missing entry file `index.html`. Click "AI Fix Errors" to regenerate the missing `index.html` entry point.';
    }
    if (/401|unauthorized|oauth|bearer|not connected/i.test(msg)) {
        return 'AppDeploy MCP server (`https://api-v2.appdeploy.ai/mcp`) requires an authorized AppDeploy user session or Bearer token. Your application code passed validation and is live in the Secure Sandbox Preview; connect an active AppDeploy token in the AppDeploy Integration tab to push to a public AppDeploy.ai domain.';
    }
    if (/syntax|unexpected token|referenceerror/i.test(msg)) {
        return 'JavaScript syntax issue detected in `app.js`. Use the AI Code Editor or click "AI Fix Errors" to automatically repair the script.';
    }
    return 'Review the step log details and run "AI Fix & Validate" to automatically inspect and repair project files before redeploying.';
}

module.exports = {
    AppDeployError,
    AppDeployAuthError,
    AppDeployMcpError,
    AppDeployValidationError,
    parseMcpHttpFailure,
    generateDiagnosticFixSuggestion
};
