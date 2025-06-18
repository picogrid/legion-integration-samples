#!/usr/bin/env node

/**
 * Setup script to create the weather service integration in Legion
 * This creates the integration using the manifest-driven API
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as dotenv from 'dotenv';

declare const __dirname: string;



interface TokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
}

interface Organization {
    organization_id: string;
    organization_name: string;
}

interface OAuthClient {
    client_id: string;
    client_secret?: string;
}

interface OAuthConfigResponse {
    id: string;
    integration_id: string;
    client_id: string;
    client_secret?: string;
    auth_flow_type: string;
    requested_scopes: string[];
    created_at: string;
    updated_at: string;
}

interface Integration {
    id: string;
    name: string;
    oauth_client?: OAuthClient;
    oauth_config?: OAuthConfigResponse;
}

interface Manifest {
    name: string;
    version: string;
    oauth_config: {
        scopes: string[];
        redirect_urls: string[];
    };
}

dotenv.config();

// Configuration
const LEGION_API_URL = process.env.LEGION_API_URL || 'http://localhost:9876/v3';
const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || 'frontend...orion';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query: string): Promise<string> => 
    new Promise(resolve => rl.question(query, resolve));

async function getAuthorizationURL(): Promise<string> {
    try {
        const url = `${LEGION_API_URL}/integrations/oauth/authorization-url`;
        console.log(`Fetching authorization URL from: ${url}`);
        
        const response = await axios.get<{ authorization_url: string }>(url);
        
        if (!response.data.authorization_url) {
            throw new Error('Empty authorization URL in response');
        }
        
        console.log(`Authorization URL: ${response.data.authorization_url}`);
        return response.data.authorization_url;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error('Failed to get authorization URL:', error.response?.status, error.response?.data || error.message);
            console.error('Full error:', error);
        } else {
            console.error('Failed to get authorization URL:', error);
        }
        throw error;
    }
}

async function getAccessToken(username: string, password: string): Promise<string> {
    try {
        const authUrl = await getAuthorizationURL();
        const parsedUrl = new URL(authUrl);
        
        // Convert authorization endpoint to token endpoint
        // e.g., /auth/realms/legion/protocol/openid-connect/auth -> /realms/legion/protocol/openid-connect/token
        let tokenPath = parsedUrl.pathname;
        if (tokenPath.includes('/auth/realms/')) {
            tokenPath = tokenPath.replace('/auth/realms/', '/realms/');
        }
        if (tokenPath.endsWith('/auth')) {
            tokenPath = tokenPath.replace('/auth', '/token');
        } else if (tokenPath.includes('/protocol/openid-connect')) {
            tokenPath = tokenPath + '/token';
        }
        
        const tokenEndpoint = `${parsedUrl.origin}${tokenPath}`;
        console.log(`Token endpoint: ${tokenEndpoint}`);
        
        const response = await axios.post<TokenResponse>(
            tokenEndpoint,
            new URLSearchParams({
                client_id: KEYCLOAK_CLIENT_ID,
                grant_type: 'password',
                username: username,
                password: password
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );
        return response.data.access_token;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error('Failed to get access token:', error.response?.status, error.response?.data || error.message);
        } else {
            console.error('Failed to get access token:', error);
        }
        throw error;
    }
}

async function getOrganizations(token: string): Promise<Organization[]> {
    try {
        const response = await axios.get<{ results: Organization[] }>(`${LEGION_API_URL}/me/orgs`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        return response.data.results || [];
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error('Failed to get organizations:', error.response?.data || error.message);
        } else {
            console.error('Failed to get organizations:', error);
        }
        throw error;
    }
}

async function setupIntegration(token: string, orgId: string, manifest: Manifest): Promise<Integration | null> {
    try {
        const response = await axios.post<Integration>(
            `${LEGION_API_URL}/integrations`,
            {
                manifest_content: manifest
            },
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-ORG-ID': orgId,
                    'Content-Type': 'application/json'
                }
            }
        );
        return response.data;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            if (error.response?.status === 409) {
                console.log('\n⚠️  Integration already exists for this organization.');
                return null;
            }
            console.error('Failed to create integration:', error.response?.data || error.message);
        } else {
            console.error('Failed to create integration:', error);
        }
        throw error;
    }
}

async function deleteIntegration(token: string, orgId: string, integrationId: string): Promise<boolean> {
    try {
        console.log(`\n🗑️  Deleting integration ${integrationId}...`);
        
        await axios.delete(
            `${LEGION_API_URL}/integrations/${integrationId}`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-ORG-ID': orgId
                }
            }
        );
        
        console.log('✅ Integration deleted successfully');
        return true;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error('Failed to delete integration:', error.response?.data || error.message);
        } else {
            console.error('Failed to delete integration:', error);
        }
        return false;
    }
}

async function main(): Promise<void> {
    // Parse command line arguments
    const args = process.argv.slice(2);
    const isDelete = args.includes('--delete') || args.includes('-d');
    
    if (isDelete) {
        console.log('🗑️  Legion Weather Service Integration Deletion\n');
    } else {
        console.log('🌦️  Legion Weather Service Integration Setup\n');
    }

    // Check if .env exists
    const envPath = path.join(__dirname, '.env');
    const envExists = fs.existsSync(envPath);

    if (!envExists) {
        console.log('Creating .env file from template...');
        fs.copyFileSync(path.join(__dirname, '.env.example'), envPath);
    }

    // Load manifest
    const manifestPath = path.join(__dirname, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        console.error('❌ manifest.json not found!');
        process.exit(1);
    }

    const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    console.log(`📋 Loaded manifest: ${manifest.name} v${manifest.version}\n`);

    // Get credentials
    const username = await question('Legion username: ');
    const password = await question('Legion password: ');

    try {
        // Get access token
        console.log('\n🔐 Authenticating...');
        const token = await getAccessToken(username, password);
        console.log('✅ Authentication successful');

        // Get organizations
        console.log('\n🏢 Fetching organizations...');
        const orgs = await getOrganizations(token);

        if (orgs.length === 0) {
            console.error('❌ No organizations found for this user');
            process.exit(1);
        }

        // Select organization
        console.log('\nAvailable organizations:');
        orgs.forEach((org, index) => {
            console.log(`  ${index + 1}. ${org.organization_name} (${org.organization_id})`);
        });

        const orgIndex = parseInt(await question('\nSelect organization (number): ')) - 1;
        if (orgIndex < 0 || orgIndex >= orgs.length) {
            console.error('❌ Invalid selection');
            process.exit(1);
        }

        const selectedOrg = orgs[orgIndex];
        console.log(`\n✅ Selected: ${selectedOrg.organization_name}`);

        // Get existing integration ID from env if available
        const existingIntegrationId = process.env.INTEGRATION_ID;

        // If delete mode, find and delete the integration
        if (isDelete) {
            console.log('\n🔍 Fetching all integrations for this organization...');
            
            try {
                // Get all integrations for the organization
                const integrationsResponse = await axios.get<{ integrations: Integration[] }>(
                    `${LEGION_API_URL}/integrations/organization/${selectedOrg.organization_id}`,
                    {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'X-ORG-ID': selectedOrg.organization_id
                        }
                    }
                );

                const integrations = integrationsResponse.data.integrations || [];
                
                if (integrations.length === 0) {
                    console.log('\n❌ No integrations found in this organization');
                    return;
                }
                
                // Show all integrations
                console.log('\nIntegrations in this organization:');
                integrations.forEach((int: Integration, index: number) => {
                    console.log(`  ${index + 1}. ${int.name} (${int.id})`);
                    if (int.oauth_client) {
                        console.log(`     OAuth Client: ${int.oauth_client.client_id}`);
                    }
                });
                
                const selection = await question('\nSelect integration to delete (number) or press Enter to cancel: ');
                if (!selection) {
                    console.log('❌ Deletion cancelled');
                    return;
                }
                
                const index = parseInt(selection) - 1;
                if (index < 0 || index >= integrations.length) {
                    console.log('❌ Invalid selection');
                    return;
                }
                
                const integrationToDelete = integrations[index].id;
                const integrationName = integrations[index].name;
                
                const confirmDelete = await question(`\nAre you sure you want to delete "${integrationName}" (${integrationToDelete})? (yes/no): `);
                
                if (confirmDelete.toLowerCase() === 'yes' || confirmDelete.toLowerCase() === 'y') {
                    const deleted = await deleteIntegration(token, selectedOrg.organization_id, integrationToDelete);
                    
                    if (deleted) {
                        // Remove integration ID from .env
                        if (envExists) {
                            let envContent = fs.readFileSync(envPath, 'utf8');
                            envContent = envContent.replace(/INTEGRATION_ID=.*\n/g, '');
                            envContent = envContent.replace(/CLIENT_ID=.*\n/g, '');
                            envContent = envContent.replace(/CLIENT_SECRET=.*\n/g, '');
                            fs.writeFileSync(envPath, envContent);
                            console.log('✅ Cleaned up .env file');
                        }
                    }
                } else {
                    console.log('❌ Deletion cancelled');
                }
            } catch (error) {
                if (axios.isAxiosError(error)) {
                    console.error('Failed to fetch integrations:', error.response?.data || error.message);
                } else {
                    console.error('Failed to fetch integrations:', error);
                }
            }
            
            return;
        }

        // Check for existing integration first
        console.log('\n🔍 Checking for existing integration...');
        let existingIntegration: Integration | null = null;
        
        // First, check if we have an integration ID in the .env file
        if (existingIntegrationId) {
            console.log(`Found integration ID in .env: ${existingIntegrationId}`);
            // Create a minimal integration object with the ID
            existingIntegration = {
                id: existingIntegrationId,
                name: manifest.name,
                oauth_client: undefined
            };
        } else {
            // Try to list integrations (this might return 404 on some environments)
            try {
                const integrationsResponse = await axios.get<{ integrations: Integration[] }>(
                    `${LEGION_API_URL}/integrations`,
                    {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'X-ORG-ID': selectedOrg.organization_id
                        }
                    }
                );

                existingIntegration = integrationsResponse.data.integrations?.find(
                    (int: Integration) => int.name === manifest.name
                ) || null;

                if (existingIntegration) {
                    console.log(`✅ Integration found via API: ${existingIntegration.id}`);
                }
            } catch (error) {
                console.warn('Could not list integrations (this is normal on some environments)');
            }
        }

        // Create integration if it doesn't exist
        let integration: Integration | null = existingIntegration;
        if (!existingIntegration) {
            console.log('\n🔧 Creating integration...');
            integration = await setupIntegration(token, selectedOrg.organization_id, manifest);
            
            if (!integration) {
                // Check if we got a 409 conflict (integration already exists)
                console.log('\n⚠️  Integration creation failed. Trying to find existing integration by name...');
                try {
                    const searchResponse = await axios.get<{ integrations: Integration[] }>(
                        `${LEGION_API_URL}/integrations`,
                        {
                            headers: {
                                'Authorization': `Bearer ${token}`,
                                'X-ORG-ID': selectedOrg.organization_id
                            }
                        }
                    );
                    
                    // Try to find by similar name (in case of minor differences)
                    const found = searchResponse.data.integrations?.find(
                        (int: Integration) => int.name.toLowerCase().includes(manifest.name.toLowerCase()) || 
                                              manifest.name.toLowerCase().includes(int.name.toLowerCase())
                    );
                    
                    if (found) {
                        console.log(`\n🔍 Found existing integration with similar name: "${found.name}" (ID: ${found.id})`);
                        const useExisting = await question('\nWould you like to use this existing integration? (yes/no): ');
                        
                        if (useExisting.toLowerCase() === 'yes' || useExisting.toLowerCase() === 'y') {
                            integration = found;
                        } else {
                            console.log('\n💡 To create a new integration, you may need to:');
                            console.log('   1. Delete the existing integration manually');
                            console.log('   2. Change the integration name in manifest.json');
                            process.exit(1);
                        }
                    }
                } catch (searchError) {
                    console.log('Could not search for existing integrations');
                }
            }
        }

        if (integration) {
            console.log('✅ Integration ready!');
            console.log('\nIntegration Details:');
            console.log(`  ID: ${integration.id}`);
            console.log(`  Name: ${integration.name}`);

            // Check if OAuth client exists - first check the new oauth_config field
            let clientId = integration.oauth_config?.client_id || integration.oauth_client?.client_id;
            let clientSecret = integration.oauth_config?.client_secret || integration.oauth_client?.client_secret;
            
            // If we got OAuth config from the integration creation response, log it
            if (integration.oauth_config && clientId) {
                console.log(`\n✅ OAuth client created with integration: ${clientId}`);
                
                if (clientSecret) {
                    console.log(`✅ OAuth client secret received: ${clientSecret.substring(0, 8)}...`);
                    console.log(`   This is a confidential client - secret will be saved to .env`);
                } else {
                    console.log(`ℹ️  No client secret in response - this is a public OAuth client`);
                    console.log(`   Public clients don't require a secret for the authorization code flow`);
                }
                
                // Log the full OAuth config details
                console.log('\nOAuth Configuration Details:');
                console.log(`  Config ID: ${integration.oauth_config.id || 'N/A'}`);
                console.log(`  Integration ID: ${integration.oauth_config.integration_id || integration.id}`);
                console.log(`  Client ID: ${integration.oauth_config.client_id}`);
                console.log(`  Client Type: ${clientSecret ? 'Confidential' : 'Public'}`);
                console.log(`  Auth Flow Type: ${integration.oauth_config.auth_flow_type || 'N/A'}`);
                console.log(`  Requested Scopes: ${integration.oauth_config.requested_scopes?.join(', ') || 'N/A'}`);
                
                if (clientSecret) {
                    console.log(`  Client Secret: ${clientSecret.substring(0, 12)}...${clientSecret.substring(clientSecret.length - 4)}`);
                }
            } else if (!clientId) {
                // Only check for OAuth client via separate API call if we don't have it from creation response
                console.log('\n🔍 Checking for OAuth client...');
                try {
                    const clientResponse = await axios.get<OAuthConfigResponse>(
                        `${LEGION_API_URL}/integrations/${integration.id}/client`,
                        {
                            headers: {
                                'Authorization': `Bearer ${token}`,
                                'X-ORG-ID': selectedOrg.organization_id
                            }
                        }
                    );
                    console.log('OAuth client response:', JSON.stringify(clientResponse.data, null, 2));
                    
                    if (clientResponse.data && clientResponse.data.client_id) {
                        clientId = clientResponse.data.client_id;
                        clientSecret = clientResponse.data.client_secret;
                        console.log(`✅ OAuth client found: ${clientId}`);
                        
                        if (clientSecret) {
                            console.log(`✅ OAuth client secret retrieved: ${clientSecret.substring(0, 8)}...`);
                            console.log(`   This is a confidential client - secret will be saved to .env`);
                        } else {
                            console.log(`ℹ️  No client secret in response - this is a public OAuth client`);
                            console.log(`   Public clients don't require a secret for the authorization code flow`);
                        }
                        
                        // Log the full OAuth config details
                        console.log('\nOAuth Configuration Details:');
                        console.log(`  Config ID: ${clientResponse.data.id || 'N/A'}`);
                        console.log(`  Integration ID: ${clientResponse.data.integration_id || integration.id}`);
                        console.log(`  Client ID: ${clientResponse.data.client_id}`);
                        console.log(`  Client Type: ${clientSecret ? 'Confidential' : 'Public'}`);
                        console.log(`  Auth Flow Type: ${clientResponse.data.auth_flow_type || 'N/A'}`);
                        console.log(`  Requested Scopes: ${clientResponse.data.requested_scopes?.join(', ') || 'N/A'}`);
                        
                        if (clientSecret) {
                            console.log(`  Client Secret: ${clientSecret.substring(0, 12)}...${clientSecret.substring(clientSecret.length - 4)}`);
                        }
                    }
                } catch (error) {
                    if (axios.isAxiosError(error) && error.response?.status === 404) {
                        console.log('❌ OAuth client not found.');
                        
                        // For existing integrations, we should try to create the OAuth client
                        if (existingIntegrationId) {
                            console.log('   This integration exists but has no OAuth client.');
                        }
                        console.log('\n🔧 Creating OAuth client...');

                        try {
                            // Create OAuth client manually
                            const oauthResponse = await axios.post<OAuthConfigResponse>(
                                `${LEGION_API_URL}/integrations/${integration.id}/oauth-configs`,
                                {
                                    name: manifest.name,
                                    auth_flow_type: 'authorization_code',
                                    requested_scopes: manifest.oauth_config.scopes,
                                    redirect_uris: manifest.oauth_config.redirect_urls,
                                    root_url: new URL(manifest.oauth_config.redirect_urls[0]).origin,
                                    client_type: 'confidential' // Request a confidential client that requires a secret
                                },
                                {
                                    headers: {
                                        'Authorization': `Bearer ${token}`,
                                        'X-ORG-ID': selectedOrg.organization_id,
                                        'Content-Type': 'application/json'
                                    }
                                }
                            );

                            if (oauthResponse.data && oauthResponse.data.client_id) {
                                clientId = oauthResponse.data.client_id;
                                clientSecret = oauthResponse.data.client_secret;
                                console.log(`✅ OAuth client created: ${clientId}`);
                                
                                console.log('\nCreated OAuth Client Details:');
                                console.log(`  Client ID: ${oauthResponse.data.client_id}`);
                                console.log(`  Client Type: ${oauthResponse.data.client_secret ? 'Confidential' : 'Public'}`);
                                if (clientSecret) {
                                    console.log(`  Client Secret: ${clientSecret}`);
                                    console.log(`✅ OAuth client secret generated (will be saved to .env)`);
                                } else {
                                    console.log(`ℹ️  No client secret generated - created as a public OAuth client`);
                                }
                            }
                        } catch (oauthError) {
                            if (axios.isAxiosError(oauthError)) {
                                console.error('❌ Failed to create OAuth client:', oauthError.response?.data || oauthError.message);
                            } else {
                                console.error('❌ Failed to create OAuth client:', oauthError);
                            }
                        }
                    } else {
                        if (axios.isAxiosError(error)) {
                            console.log('⚠️  Error checking OAuth client:', error.response?.data || error.message);
                        } else {
                            console.log('⚠️  Error checking OAuth client:', error as Error);
                        }
                    }
                }
            }

            console.log(`  OAuth Client ID: ${clientId || 'Not created yet'}`);
            console.log(`  OAuth Client Type: ${clientSecret ? 'Confidential (requires secret)' : 'Public (no secret required)'}`);

            // Update .env file
            console.log('\n📝 Updating .env file...');
            let envContent = fs.readFileSync(envPath, 'utf8');

            // Update CLIENT_ID
            if (clientId) {
                if (envContent.includes('CLIENT_ID=')) {
                    envContent = envContent.replace(
                        /CLIENT_ID=.*/,
                        `CLIENT_ID=${clientId}`
                    );
                } else {
                    // Add CLIENT_ID if it doesn't exist
                    envContent = envContent.replace(
                        /PORT=3001/,
                        `PORT=3001\nCLIENT_ID=${clientId}`
                    );
                }
            }

            // Update CLIENT_SECRET
            if (clientSecret) {
                if (envContent.includes('CLIENT_SECRET=')) {
                    envContent = envContent.replace(
                        /CLIENT_SECRET=.*/,
                        `CLIENT_SECRET=${clientSecret}`
                    );
                } else {
                    // Add CLIENT_SECRET if it doesn't exist
                    envContent = envContent.replace(
                        /CLIENT_ID=.*/,
                        `CLIENT_ID=${clientId}\nCLIENT_SECRET=${clientSecret}`
                    );
                }
            }

            // Add integration ID
            if (!envContent.includes('INTEGRATION_ID=')) {
                envContent += `\n# Integration Details\nINTEGRATION_ID=${integration.id}\n`;
            } else {
                envContent = envContent.replace(
                    /INTEGRATION_ID=.*/,
                    `INTEGRATION_ID=${integration.id}`
                );
            }

            fs.writeFileSync(envPath, envContent);
            console.log('✅ Configuration updated');

            console.log('\n🎉 Setup complete! Next steps:');
            console.log('  1. Start the OAuth server: yarn start');
            console.log('  2. Open http://localhost:3001 in your browser');
            console.log('  3. Click "Install Integration" to begin the OAuth flow');
            console.log('  4. The demo will guide you through the authorization process');
        } else {
            console.log('\n📌 Integration already exists. Next steps:');
            console.log('  1. Start the OAuth server: yarn start');
            console.log('  2. Open http://localhost:3001 in your browser');
            console.log('  3. Use the demo to test the existing integration');
        }

    } catch (error) {
        console.error('\n❌ Setup failed:', (error as Error).message);
        process.exit(1);
    } finally {
        rl.close();
    }
}

// Run the setup
main().catch(error => {
    console.error('Unexpected error:', error as Error);
    process.exit(1);
});