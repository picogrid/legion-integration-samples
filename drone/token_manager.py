from typing import Dict, List, Optional, Any

class TokenManager:
    """Token manager class to handle automatic refresh"""

    def __init__(self, auth_data: Dict[str, Any]):
        self.access_token = auth_data['access_token']
        self.refresh_token = auth_data['refresh_token']
        self.expires_in = auth_data['expires_in']
        self.token_expiry = datetime.now() + timedelta(seconds=auth_data['expires_in'])
        self.refresh_margin = timedelta(seconds=30)

    def get_access_token(self) -> str:
        return self.access_token

    def is_token_expired(self) -> bool:
        return datetime.now() >= (self.token_expiry - self.refresh_margin)

    async def ensure_valid_token(self, session: aiohttp.ClientSession) -> str:
        if self.is_token_expired():
            print('🔄 Token expired, refreshing...')
            try:
                new_token_data = await refresh_token(session, self.refresh_token)
                self.access_token = new_token_data['access_token']
                self.refresh_token = new_token_data['refresh_token']
                self.expires_in = new_token_data['expires_in']
                self.token_expiry = datetime.now() + timedelta(seconds=new_token_data['expires_in'])
                print('✅ Token refreshed successfully')
            except Exception as e:
                error_msg = str(e)
                if any(phrase in error_msg for phrase in ['Token is not active', 'invalid_grant', 'Refresh token expired']):
                    raise Exception('SESSION_EXPIRED')
                raise Exception(f'Failed to refresh token: {error_msg}')
        return self.access_token

    def update_tokens(self, auth_data: Dict[str, Any]):
        """Update the token manager with new authentication data"""
        self.access_token = auth_data['access_token']
        self.refresh_token = auth_data['refresh_token']
        self.expires_in = auth_data['expires_in']
        self.token_expiry = datetime.now() + timedelta(seconds=auth_data['expires_in'])
        print('✅ Token manager updated with new credentials')
