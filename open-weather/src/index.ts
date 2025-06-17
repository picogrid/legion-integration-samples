import express from 'express';
import * as dotenv from 'dotenv';
import * as path from 'path';
import axios from 'axios';
import crypto from 'crypto';

// Load environment variables from .env file
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuration
const config = {
    PORT: process.env.PORT || 3001,
    LEGION_API_URL: process.env.LEGION_API_URL || 'http://localhost:9876',
    CLIENT_ID: process.env.CLIENT_ID || '', // Will be set after integration creation
    CLIENT_SECRET: process.env.CLIENT_SECRET || '', // Optional for public clients
    REDIRECT_URI: process.env.REDIRECT_URI || 'http://localhost:3001/oauth/callback',
    OPENWEATHER_API_KEY: process.env.OPENWEATHER_API_KEY || ''
};

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '..', 'public')));

/**
 * We need somewhere to save all of the organizations we have access to, along with their tokens
 * So we will mimic a datastore. In production, please use a secure data solution
 */
interface OrgData {
    tokens: any;
    activatedAt: Date;
}

const activeOrganizations = new Map<string, OrgData>(); // orgId -> { tokens, activatedAt }
const oauthStates = new Map<string, { orgId: string; timestamp: number }>(); // state -> { orgId, timestamp }

// Clean up old OAuth states periodically
setInterval(() => {
    const oneHourAgo = Date.now() - 3600000;
    for (const [state, data] of oauthStates.entries()) {
        if (data.timestamp < oneHourAgo) {
            oauthStates.delete(state);
        }
    }
}, 3600000); // Check every hour

/**
 * Get authorization URL from Legion
 */
async function getAuthorizationURL(): Promise<string> {
    try {
        const response = await axios.get(
            `${config.LEGION_API_URL}/integrations/oauth/authorization-url`
        );
        return response.data.authorization_url;
    } catch (error) {
        console.error('Failed to get authorization URL:', error);
        throw error;
    }
}

/**
 * Decode JWT token to extract organization ID
 */
function extractOrgIdFromToken(accessToken: string): string | null {
    try {
        const tokenParts = accessToken.split('.');
        if (tokenParts.length !== 3) {
            console.error('Invalid JWT format');
            return null;
        }
        
        const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
        console.log('JWT Token payload:', JSON.stringify(payload, null, 2));
        
        // Try different possible fields for organization ID
        const organizationId = payload.org_id || 
                            payload.organization_id || 
                            payload['legion:org_id'] ||
                            payload.orgs?.[0]?.organization_id ||
                            payload.organizations?.[0]?.id;
        
        // If not found, try to extract from scopes
        // Scopes are in format: {org_id}:::{scope_name}
        if (!organizationId && payload.scope) {
            console.log('Attempting to extract org ID from scopes...');
            const scopes = payload.scope.split(' ');
            if (scopes.length > 0) {
                const firstScope = scopes[0];
                const scopeParts = firstScope.split(':::');
                if (scopeParts.length >= 2) {
                    console.log('Extracted organization ID from scope:', scopeParts[0]);
                    return scopeParts[0];
                }
            }
        }
        
        return organizationId || null;
    } catch (err) {
        console.error('Failed to decode JWT:', err);
        return null;
    }
}

/**
 * API endpoint to get available organizations (mock data for demo)
 */
app.get('/api/organizations', (_req: express.Request, res: express.Response) => {
    // In a real implementation, this would fetch from Legion API
    // For demo purposes, return mock data
    const mockOrgs = [
        { organization_id: 'org-1', organization_name: 'Demo Organization 1' },
        { organization_id: 'org-2', organization_name: 'Demo Organization 2' }
    ];
    
    res.json({ organizations: mockOrgs });
});

/**
 * Check if integration is installed for an organization
 */
app.get('/api/integration-status/:orgId', (req: express.Request, res: express.Response) => {
    const { orgId } = req.params;
    const orgData = activeOrganizations.get(orgId);
    
    res.json({
        installed: !!orgData && !!orgData.tokens,
        hasTokens: !!orgData?.tokens
    });
});

/**
 * Initiate OAuth connection - matches the working example
 */
app.get('/connect', (req: express.Request, res: express.Response): void => {
    const { org_id } = req.query;
    
    if (!org_id) {
        res.status(400).send('Missing organization ID');
        return;
    }
    
    if (!config.CLIENT_ID) {
        res.status(500).send('Integration not configured. Please set CLIENT_ID.');
        return;
    }
    
    // Generate state for CSRF protection
    const state = crypto.randomBytes(16).toString('hex');
    oauthStates.set(state, { orgId: org_id as string, timestamp: Date.now() });
    
    // Build authorization URL - don't use new URL() as it strips the path from base URL
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: config.CLIENT_ID,
        organization_id: org_id as string,
        redirect_uri: config.REDIRECT_URI,
        state: state
    });
    
    const authUrl = `${config.LEGION_API_URL}/integrations/oauth/authorize?${params.toString()}`;
    
    // Redirect to Legion OAuth
    res.redirect(authUrl);
});

/**
 * API endpoint to initiate OAuth flow (for HTML page)
 */
app.get('/api/oauth/initiate/:orgId', async (req: express.Request, res: express.Response): Promise<void> => {
    const { orgId } = req.params;
    
    try {
        if (!config.CLIENT_ID) {
            throw new Error('Integration not configured. Please set CLIENT_ID.');
        }
        
        // Generate state for CSRF protection
        const state = crypto.randomBytes(16).toString('hex');
        oauthStates.set(state, { orgId, timestamp: Date.now() });
        
        // Build authorization URL - don't use new URL() as it strips the path from base URL
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: config.CLIENT_ID,
            organization_id: orgId,
            redirect_uri: config.REDIRECT_URI,
            state: state
        });
        
        const authUrl = `${config.LEGION_API_URL}/integrations/oauth/authorize?${params.toString()}`;
        
        res.json({ authUrl });
    } catch (error) {
        console.error('Failed to initiate OAuth:', error);
        res.status(500).json({ error: 'Failed to initiate OAuth flow' });
    }
});

/**
 * OAuth callback handler - matching the working example
 */
app.get('/oauth/callback', async (req: express.Request, res: express.Response): Promise<void> => {
    const { code, state, error, error_description } = req.query;
    
    if (error) {
        res.status(400).send(`OAuth error: ${error} - ${error_description || ''}`);
        return;
    }
    
    // Check if this is from our own connect flow or external (like map UI)
    const stateData = oauthStates.get(state as string);
    let organizationId: string | null = null;
    
    if (stateData) {
        // State from our own /connect flow
        organizationId = stateData.orgId;
        oauthStates.delete(state as string);
    } else {
        // State from external application (e.g., map UI)
        console.log('OAuth callback from external application');
    }
    
    try {
        // Exchange code for tokens
        const tokenRequest: any = {
            grant_type: 'authorization_code',
            code: code as string,
            client_id: config.CLIENT_ID,
            redirect_uri: config.REDIRECT_URI
        };
        
        // Only add client_secret if it's configured
        if (config.CLIENT_SECRET) {
            tokenRequest.client_secret = config.CLIENT_SECRET;
        }
        
        console.log('Token exchange request:', {
            ...tokenRequest,
            client_secret: tokenRequest.client_secret ? '***' : 'not provided',
            code: (code as string).substring(0, 8) + '...'
        });
        
        // Try the token exchange - first with Legion API, then fallback to Keycloak directly
        let tokenResponse;
        try {
            tokenResponse = await axios.post(
                `${config.LEGION_API_URL}/integrations/oauth/token`,
                tokenRequest,
                {
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        } catch (apiError: any) {
            console.error('Legion API token exchange failed:', apiError.response?.status, apiError.response?.data);
            
            // Fallback to getting auth URL and deriving token endpoint
            console.log('Trying token endpoint directly...');
            
            const authUrl = await getAuthorizationURL();
            // Fix the token URL - ensure we're replacing the right part
            let tokenUrl = authUrl;
            if (authUrl.endsWith('/auth')) {
                tokenUrl = authUrl.substring(0, authUrl.length - 5) + '/token';
            } else {
                // If it doesn't end with /auth, append /token
                tokenUrl = authUrl.replace('/protocol/openid-connect', '/protocol/openid-connect/token');
            }
            console.log('Token URL:', tokenUrl);
            
            // For Keycloak, we need form-encoded data
            tokenResponse = await axios.post(
                tokenUrl,
                new URLSearchParams({
                    grant_type: 'authorization_code',
                    code: code as string,
                    client_id: config.CLIENT_ID,
                    redirect_uri: config.REDIRECT_URI,
                    ...(tokenRequest.client_secret && { client_secret: tokenRequest.client_secret })
                }),
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                }
            );
        }
        
        const tokens = tokenResponse.data;
        
        // If we don't have organizationId, extract it from the token
        if (!organizationId) {
            organizationId = extractOrgIdFromToken(tokens.access_token);
            if (!organizationId) {
                throw new Error('Could not determine organization ID from token');
            }
            console.log('Extracted organization ID:', organizationId);
        }
        
        // Store organization data
        activeOrganizations.set(organizationId, {
            tokens: tokens,
            activatedAt: new Date()
        });
        
        // Success page
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Connection Successful</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        max-width: 600px;
                        margin: 100px auto;
                        text-align: center;
                        padding: 20px;
                    }
                    .success {
                        background: #d4edda;
                        border: 1px solid #c3e6cb;
                        color: #155724;
                        padding: 20px;
                        border-radius: 4px;
                        margin-bottom: 20px;
                    }
                    .info {
                        background: #e3f2fd;
                        padding: 15px;
                        border-radius: 4px;
                        margin: 20px 0;
                        text-align: left;
                    }
                    .btn {
                        display: inline-block;
                        background: #28a745;
                        color: white;
                        padding: 10px 20px;
                        border-radius: 4px;
                        text-decoration: none;
                        margin-top: 20px;
                    }
                </style>
            </head>
            <body>
                <div class="success">
                    <h1>✓ Connection Successful!</h1>
                    <p>Legion Weather Service is now active for your organization.</p>
                    <p>Organization ID: ${organizationId}</p>
                </div>
                <p>You can close this window and return to the Legion platform.</p>
                <a href="/" class="btn">View Demo</a>
            </body>
            </html>
        `);
        
    } catch (error: any) {
        console.error('Token exchange error:', error);
        res.status(500).send(`Failed to complete OAuth flow: ${error.message}`);
    }
});

/**
 * Get weather data for an organization
 */
app.get('/api/weather/:orgId', async (req: express.Request, res: express.Response): Promise<void> => {
    const { orgId } = req.params;
    const orgData = activeOrganizations.get(orgId);
    
    if (!orgData || !orgData.tokens) {
        res.status(401).json({ error: 'Organization not authorized' });
        return;
    }
    
    try {
        // For demo purposes, return mock weather data
        // In a real implementation, this would:
        // 1. Use the Legion access token to get user preferences
        // 2. Call OpenWeather API with the location
        const mockWeatherData = {
            location: 'San Francisco, CA',
            temperature: 18,
            description: 'Partly cloudy',
            humidity: 65,
            wind_speed: 3.5,
            timestamp: new Date().toISOString()
        };
        
        res.json(mockWeatherData);
    } catch (error) {
        console.error('Failed to get weather:', error);
        res.status(500).json({ error: 'Failed to fetch weather data' });
    }
});

/**
 * Disconnect endpoint
 */
app.post('/oauth/disconnect', async (req: express.Request, res: express.Response): Promise<void> => {
    const { organization_id } = req.body;
    
    if (!organization_id) {
        res.status(400).json({ error: 'Missing organization_id' });
        return;
    }
    
    const orgData = activeOrganizations.get(organization_id);
    if (!orgData) {
        res.status(404).json({ error: 'Organization not found' });
        return;
    }
    
    // Remove from active organizations
    activeOrganizations.delete(organization_id);
    
    res.json({ message: 'Disconnected successfully' });
});

/**
 * Status endpoint
 */
app.get('/status', (_req: express.Request, res: express.Response) => {
    const status = {
        active_organizations: activeOrganizations.size,
        organizations: Array.from(activeOrganizations.entries()).map(([orgId, data]) => ({
            organization_id: orgId,
            activated_at: data.activatedAt
        }))
    };
    
    res.json(status);
});

/**
 * Health check endpoint
 */
app.get('/health', (_req: express.Request, res: express.Response) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        config: {
            hasClientId: !!config.CLIENT_ID,
            hasOpenWeatherKey: !!config.OPENWEATHER_API_KEY,
            legionApiUrl: config.LEGION_API_URL
        }
    });
});

// Start server
app.listen(config.PORT, () => {
    console.log(`🌦️  Legion Weather Service running on http://localhost:${config.PORT}`);
    console.log(`   OAuth callback URL: ${config.REDIRECT_URI}`);
    
    if (!config.CLIENT_ID) {
        console.log('\n⚠️  Warning: CLIENT_ID not set. Run "yarn setup" to configure the integration.');
    }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('Shutting down gracefully...');
    
    // Clear all data
    activeOrganizations.clear();
    oauthStates.clear();
    
    process.exit(0);
});