import type { TokenResponse } from '../types';

export function storeBokioToken(apiToken: string): TokenResponse {
  return {
    access_token: apiToken,
    refresh_token: '',
    token_type: 'Bearer',
    expires_in: 0,
  };
}
