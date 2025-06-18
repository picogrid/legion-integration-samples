# Legion Weather Service Integration Demo

This demo shows how to create and install a Legion integration using simple HTML pages for testing OAuth flows.

## Features

- OAuth 2.0 authorization code flow
- Simple HTML interface for testing
- Support for external OAuth initiation (e.g., from Legion Map UI)
- JWT token parsing for organization ID extraction
- Real weather data from OpenWeather API
- Active organization status tracking

## Prerequisites

- Node.js (v14 or higher)
- Yarn package manager
- Legion API access (username and password)

## Setup

1. Install dependencies:
   ```bash
   yarn install
   ```

2. Configure the integration:
   ```bash
   yarn setup
   ```
   
   This will:
   - Create the integration in Legion
   - Generate an OAuth client with credentials
   - Update your `.env` file with the client ID and secret (if confidential client)

3. Start the server:
   ```bash
   yarn start
   ```

4. Open your browser to http://localhost:3001

## Using the Demo

### Method 1: Direct Connection (HTML Interface)

1. **Enter Organization ID**: Type your organization ID in the form
2. **Click Connect**: This initiates the OAuth flow with `/connect?org_id=YOUR_ORG_ID`
3. **Authorize**: You'll be redirected to Legion's OAuth authorization page
4. **Grant Access**: Approve the integration's requested permissions
5. **Success**: You'll see a confirmation and can test the weather API

### Method 2: External OAuth Initiation

The integration also supports OAuth flows initiated from external sources (like Legion Map UI):
- The callback handler automatically extracts the organization ID from the JWT token
- No prior state is required - the integration handles external OAuth callbacks gracefully

## Project Structure

```
open-weather/
├── src/
│   └── index.ts        # Express server with OAuth endpoints
├── public/
│   └── index.html      # Demo HTML interface
├── manifest.json       # Integration manifest
├── setup-integration.ts # Setup script
└── .env               # Configuration (created by setup)
```

## API Endpoints

- `GET /` - Demo HTML interface
- `GET /connect?org_id=X` - Initiate OAuth flow for organization
- `GET /oauth/callback` - OAuth callback handler (supports both internal and external flows)
- `GET /api/organizations` - List available organizations (mock data)
- `GET /api/integration-status/:orgId` - Check if integration is installed
- `GET /api/oauth/initiate/:orgId` - Start OAuth flow (API endpoint)
- `GET /api/weather/:orgId?city=CityName` - Get real weather data from OpenWeather API
- `POST /oauth/disconnect` - Disconnect an organization
- `GET /status` - View all connected organizations
- `GET /health` - Health check

## OAuth Flow Details

The integration supports two OAuth patterns:

1. **Internal Flow**: Initiated from the demo page
   - State is generated and tracked
   - Organization ID is passed via query parameter

2. **External Flow**: Initiated from Legion platform
   - No prior state required
   - Organization ID is extracted from JWT token claims
   - Supports multiple claim formats:
     - `org_id`, `organization_id`, `legion:org_id`
     - Organization arrays in token
     - Scope-based extraction (`{org_id}:::{scope_name}`)

## Development Notes

- Tokens are stored in memory (lost on restart)
- For demo purposes, mock organization data is provided
- Weather data is fetched from OpenWeather API (requires API key in .env)
- Token exchange includes fallback logic for different environments
- Client secret is optional for public OAuth clients

## Environment Variables

```env
PORT=3001
LEGION_API_URL=http://localhost:9876
CLIENT_ID=                    # Set by setup script
CLIENT_SECRET=                # Optional for public clients
REDIRECT_URI=http://localhost:3001/oauth/callback
OPENWEATHER_API_KEY=          # Required - Get from https://openweathermap.org/api
```

## Troubleshooting

1. **"CLIENT_ID not set" warning**: Run `yarn setup` first
2. **OAuth errors**: Check that your redirect URI matches the manifest
3. **Token exchange fails**: The server will automatically try fallback endpoints
4. **Organization ID not found**: Check JWT token structure in console logs
5. **TypeScript errors**: Ensure all dependencies are installed with `yarn install`