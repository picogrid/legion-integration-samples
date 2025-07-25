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
const weatherStations = new Map<string, any[]>(); // orgId -> array of weather station entities
const feedDefinitionCache = new Map<string, any>(); // feedName -> feed definition

// Clean up old OAuth states periodically
setInterval(() => {
    const oneHourAgo = Date.now() - 3600000;
    for (const [state, data] of oauthStates.entries()) {
        if (data.timestamp < oneHourAgo) {
            oauthStates.delete(state);
        }
    }
}, 3600000); // Check every hour

// Weather feed definition constants
const WEATHER_FEED_NAME = 'weather_conditions';
const WEATHER_FEED_DESCRIPTION = 'Current weather conditions including temperature, humidity, pressure';

// Convert lat/lon to ECEF coordinates (Earth-Centered, Earth-Fixed)
function latLonToECEF(lat: number, lon: number, alt: number = 0) {
    // WGS84 ellipsoid constants
    const a = 6378137.0; // semi-major axis
    const f = 1 / 298.257223563; // flattening
    const e2 = 2 * f - f * f; // first eccentricity squared

    const latRad = lat * Math.PI / 180;
    const lonRad = lon * Math.PI / 180;

    const N = a / Math.sqrt(1 - e2 * Math.sin(latRad) * Math.sin(latRad));

    const x = (N + alt) * Math.cos(latRad) * Math.cos(lonRad);
    const y = (N + alt) * Math.cos(latRad) * Math.sin(lonRad);
    const z = (N * (1 - e2) + alt) * Math.sin(latRad);

    return { x, y, z };
}

// Get city coordinates from OpenWeather API
async function getCityCoordinates(city: string, apiKey: string): Promise<{ lat: number; lon: number; name: string; country: string } | null> {
    try {
        const response = await axios.get('https://api.openweathermap.org/data/2.5/weather', {
            params: {
                q: city,
                appid: apiKey,
                units: 'metric'
            }
        });
        
        return {
            lat: response.data.coord.lat,
            lon: response.data.coord.lon,
            name: response.data.name,
            country: response.data.sys.country
        };
    } catch (error) {
        console.error('Failed to get city coordinates:', error);
        return null;
    }
}

// Make authenticated Legion API request
async function legionApiRequest(orgId: string, path: string, method: string = 'GET', body?: any) {
    const orgData = activeOrganizations.get(orgId);
    
    if (!orgData || !orgData.tokens) {
        throw new Error('Organization not authorized');
    }
    
    const headers: any = {
        'Authorization': `Bearer ${orgData.tokens.access_token}`,
        'X-ORG-ID': orgId
    };
    
    if (body) {
        headers['Content-Type'] = 'application/json';
    }
    
    // Build full URL - config.LEGION_API_URL already includes /v3
    const url = `${config.LEGION_API_URL}${path}`;
    
    console.log('Legion API Request:', method, url);
    
    const response = await axios({
        method,
        url,
        headers,
        data: body
    });
    
    return response.data;
}

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
    const { city = 'San Francisco', units = 'metric' } = req.query;
    const orgData = activeOrganizations.get(orgId);
    
    if (!orgData || !orgData.tokens) {
        res.status(401).json({ error: 'Organization not authorized' });
        return;
    }
    
    if (!config.OPENWEATHER_API_KEY) {
        res.status(500).json({ error: 'OpenWeather API key not configured' });
        return;
    }
    
    try {
        // Debug log
        console.log('Weather request for city:', city, 'units:', units);
        
        // Call OpenWeather API
        const weatherResponse = await axios.get('https://api.openweathermap.org/data/2.5/weather', {
            params: {
                q: city as string,
                appid: config.OPENWEATHER_API_KEY,
                units: units as string
            }
        });
        
        const data = weatherResponse.data;
        
        // Format the response
        const weatherData = {
            location: `${data.name}, ${data.sys.country}`,
            temperature: Math.round(data.main.temp),
            description: data.weather[0].description,
            humidity: data.main.humidity,
            wind_speed: data.wind.speed,
            feels_like: Math.round(data.main.feels_like),
            temp_min: Math.round(data.main.temp_min),
            temp_max: Math.round(data.main.temp_max),
            pressure: data.main.pressure,
            icon: data.weather[0].icon,
            timestamp: new Date().toISOString()
        };
        
        res.json(weatherData);
    } catch (error: any) {
        console.error('Failed to get weather:', error.response?.data || error.message);
        console.error('Request URL:', error.config?.url);
        console.error('Request params:', error.config?.params);
        
        if (error.response?.status === 404) {
            res.status(404).json({ error: 'City not found' });
        } else if (error.response?.status === 401) {
            res.status(500).json({ error: 'Invalid OpenWeather API key' });
        } else {
            res.status(500).json({ error: 'Failed to fetch weather data' });
        }
    }
});

/**
 * Create or get weather feed definition
 */
async function ensureWeatherFeedDefinition(orgId: string): Promise<any> {
    // Check cache first
    const cacheKey = `${orgId}-${WEATHER_FEED_NAME}`;
    if (feedDefinitionCache.has(cacheKey)) {
        return feedDefinitionCache.get(cacheKey);
    }
    
    try {
        // Search for existing feed definition
        const searchResponse = await legionApiRequest(orgId, '/feeds/definitions/search', 'POST', {
            types: [WEATHER_FEED_NAME]
        });
        
        if (searchResponse.results && searchResponse.results.length > 0) {
            const feedDef = searchResponse.results[0];
            feedDefinitionCache.set(cacheKey, feedDef);
            return feedDef;
        }
        
        // Create new feed definition
        const feedDef = await legionApiRequest(orgId, '/feeds/definitions', 'POST', {
            feed_name: WEATHER_FEED_NAME,
            description: WEATHER_FEED_DESCRIPTION,
            category: 'MESSAGE',
            data_type: 'application/json',
            is_active: true,
            is_template: false
        });
        
        feedDefinitionCache.set(cacheKey, feedDef);
        return feedDef;
    } catch (error) {
        console.error('Failed to ensure feed definition:', error);
        throw error;
    }
}

/**
 * Get weather stations for an organization
 */
app.get('/api/weather-stations/:orgId', async (req: express.Request, res: express.Response): Promise<void> => {
    const { orgId } = req.params;
    
    try {
        // Get stations from cache first
        let stations = weatherStations.get(orgId) || [];
        
        // If no cached stations, search in Legion
        if (stations.length === 0) {
            const searchResponse = await legionApiRequest(orgId, '/entities/search', 'POST', {
                organization_id: orgId,
                filters: {
                    category: ['SENSOR'],
                    types: ['weather_station']
                }
            });
            
            // Handle different response formats
            if (searchResponse && searchResponse.results) {
                stations = searchResponse.results;
            } else if (Array.isArray(searchResponse)) {
                stations = searchResponse;
            } else {
                stations = [];
            }
            weatherStations.set(orgId, stations);
        }
        
        res.json({ stations });
    } catch (error: any) {
        console.error('Failed to get weather stations:', error);
        console.error('Error details:', error.response?.data || error.message);
        
        // If it's a 404, return empty array as there are no stations yet
        if (error.response?.status === 404 || error.code === 'ERR_BAD_REQUEST') {
            console.log('No weather stations found yet, returning empty array');
            res.json({ stations: [] });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

/**
 * Create a new weather station
 */
app.post('/api/weather-stations/:orgId', async (req: express.Request, res: express.Response): Promise<void> => {
    const { orgId } = req.params;
    const { city } = req.body;
    
    if (!city) {
        res.status(400).json({ error: 'City name is required' });
        return;
    }
    
    if (!config.OPENWEATHER_API_KEY) {
        res.status(500).json({ error: 'OpenWeather API key not configured' });
        return;
    }
    
    try {
        // Get city coordinates
        const coords = await getCityCoordinates(city, config.OPENWEATHER_API_KEY);
        if (!coords) {
            res.status(404).json({ error: 'City not found' });
            return;
        }
        
        // Create entity in Legion
        const entity = await legionApiRequest(orgId, '/entities', 'POST', {
            organization_id: orgId,
            name: `Weather Station - ${coords.name}, ${coords.country}`,
            category: 'SENSOR',
            type: 'weather_station',
            status: 'active',
            metadata: {
                city: coords.name,
                country: coords.country,
                lat: coords.lat,
                lon: coords.lon,
                capabilities: ['temperature', 'humidity', 'pressure', 'wind', 'visibility']
            }
        });
        
        // Add location to the entity
        const ecef = latLonToECEF(coords.lat, coords.lon);
        await legionApiRequest(orgId, `/entities/${entity.id}/locations`, 'POST', {
            position: {
                type: 'Point',
                coordinates: [ecef.x, ecef.y, ecef.z]
            },
            recorded_at: new Date().toISOString()
        });
        
        // Update cache
        const stations = weatherStations.get(orgId) || [];
        stations.push(entity);
        weatherStations.set(orgId, stations);
        
        // Ensure feed definition exists
        await ensureWeatherFeedDefinition(orgId);
        
        res.json({ 
            message: 'Weather station created successfully',
            station: entity
        });
    } catch (error: any) {
        console.error('Failed to create weather station:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Update weather data for a station
 */
app.post('/api/weather-stations/:orgId/:stationId/update', async (req: express.Request, res: express.Response): Promise<void> => {
    const { orgId, stationId } = req.params;
    
    if (!config.OPENWEATHER_API_KEY) {
        res.status(500).json({ error: 'OpenWeather API key not configured' });
        return;
    }
    
    try {
        // Get station details
        const stations = weatherStations.get(orgId) || [];
        const station = stations.find(s => s.id === stationId);
        
        if (!station) {
            // Try to fetch from API
            const entity = await legionApiRequest(orgId, `/entities/${stationId}`, 'GET');
            if (!entity || entity.type !== 'weather_station') {
                res.status(404).json({ error: 'Weather station not found' });
                return;
            }
            stations.push(entity);
            weatherStations.set(orgId, stations);
        }
        
        const stationData = station || stations[stations.length - 1];
        const city = stationData.metadata.city;
        
        // Fetch weather data
        const weatherResponse = await axios.get('https://api.openweathermap.org/data/2.5/weather', {
            params: {
                q: city,
                appid: config.OPENWEATHER_API_KEY,
                units: 'metric'
            }
        });
        
        const data = weatherResponse.data;
        
        // Prepare feed payload
        const feedPayload = {
            temperature: data.main.temp,
            feels_like: data.main.feels_like,
            humidity: data.main.humidity,
            pressure: data.main.pressure,
            visibility: data.visibility,
            wind_speed: data.wind.speed,
            wind_direction: data.wind.deg,
            weather: data.weather[0].main,
            weather_description: data.weather[0].description,
            clouds: data.clouds.all,
            timestamp: new Date().toISOString()
        };
        
        // Get feed definition
        const feedDef = await ensureWeatherFeedDefinition(orgId);
        
        // Push data to feed
        await legionApiRequest(orgId, '/feeds/messages', 'POST', {
            entity_id: stationId,
            feed_definition_id: feedDef.id,
            recorded_at: new Date().toISOString(),
            payload: feedPayload
        });
        
        res.json({ 
            message: 'Weather data updated successfully',
            data: feedPayload
        });
    } catch (error: any) {
        console.error('Failed to update weather data:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Delete a weather station
 */
app.delete('/api/weather-stations/:orgId/:stationId', async (req: express.Request, res: express.Response): Promise<void> => {
    const { orgId, stationId } = req.params;
    
    try {
        await legionApiRequest(orgId, `/entities/${stationId}`, 'DELETE');
        
        // Update cache
        const stations = weatherStations.get(orgId) || [];
        const filtered = stations.filter(s => s.id !== stationId);
        weatherStations.set(orgId, filtered);
        
        res.json({ message: 'Weather station deleted successfully' });
    } catch (error: any) {
        console.error('Failed to delete weather station:', error);
        res.status(500).json({ error: error.message });
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
    
    // Clear cached weather stations
    weatherStations.delete(organization_id);
    
    // Clear feed definition cache for this org
    for (const [key] of feedDefinitionCache.entries()) {
        if (key.startsWith(`${organization_id}-`)) {
            feedDefinitionCache.delete(key);
        }
    }
    
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
    
    if (!config.OPENWEATHER_API_KEY) {
        console.log('\n⚠️  Warning: OPENWEATHER_API_KEY not set. Please add it to your .env file.');
    } else {
        console.log(`   OpenWeather API: Configured (key: ${config.OPENWEATHER_API_KEY.substring(0, 8)}...)`);
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