# Token Refresh Implementation

## Overview

The Obsidian plugin now implements automatic token refresh to eliminate the need for manual re-authentication every 24 hours.

## Features

### 1. Secure Token Storage

**Desktop (Electron safeStorage API)**:
- **macOS**: Tokens stored in KeyChain
- **Windows**: Tokens stored in Credential Manager  
- **Linux**: Tokens stored via Secret Service API/libsecret

**Mobile/Fallback**:
- Basic obfuscation (XOR + Base64)
- Warning notice shown to users
- Recommended to use desktop for maximum security

### 2. Automatic Token Refresh

- Tokens automatically refresh **1 hour before expiration**
- Background task schedules next refresh
- No user intervention required
- Silent success notifications

### 3. Error Handling

**401 Unauthorized**:
- Automatically attempts token refresh
- Retries failed request with new token
- Falls back to re-authentication if refresh fails

**Refresh Token Expiry**:
- Clears stored tokens
- Shows user notice to log in again
- Clean logout state

### 4. Settings UI

New settings display:
- **Token Storage Method**: Shows encryption method used
- **Token Status**: Time until expiration
- **Refresh Now Button**: Manual refresh for testing

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        ApiClient                             │
│  - All API calls go through request()                        │
│  - Automatically gets fresh token before each request        │
│  - Retries 401 errors after token refresh                    │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                     TokenManager                             │
│  - Checks token expiry before each use                       │
│  - Auto-refreshes if < 1 hour remaining                      │
│  - Schedules background refresh (23 hours)                   │
│  - Handles 401 with refresh + retry logic                    │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    TokenStorage                              │
│  - Electron safeStorage (desktop): OS-level encryption       │
│  - Fallback (mobile): XOR obfuscation + Base64              │
│  - Stores: accessToken, refreshToken, expiresAt              │
└─────────────────────────────────────────────────────────────┘
```

## API Flow

### Initial Authentication

```typescript
// User enters token in settings
settings.apiToken = "eyJ..."
settings.refreshToken = "eyJ..."

// TokenManager initializes
await tokenManager.initialize(accessToken, refreshToken)

// Tokens stored securely
await tokenStorage.storeTokens({
    accessToken: "eyJ...",
    refreshToken: "eyJ...",
    expiresAt: Date.now() + (24 * 60 * 60 * 1000)
})

// Background refresh scheduled (23 hours from now)
```

### API Request with Auto-Refresh

```typescript
// 1. User makes API call
await apiClient.getEntries()

// 2. TokenManager checks expiry
const token = await tokenManager.getAccessToken()
// -> Token expires in 30 minutes
// -> Auto-refresh triggered

// 3. Refresh API call
POST /api/v1/auth/refresh/
{ "refresh": "eyJ..." }
// -> Returns new access token

// 4. Update stored tokens
await tokenStorage.storeTokens({
    accessToken: "eyJ_NEW...",
    refreshToken: "eyJ...", // Same
    expiresAt: Date.now() + (24 * 60 * 60 * 1000)
})

// 5. Original API call proceeds with new token
GET /api/v1/entries/
Authorization: Bearer eyJ_NEW...
```

### 401 Retry Flow

```typescript
// 1. API call fails with 401
GET /api/v1/entries/
Response: 401 Unauthorized

// 2. TokenManager attempts refresh
await tokenManager.handleUnauthorized()

// 3. If refresh succeeds
// -> Retry original request with new token
GET /api/v1/entries/
Authorization: Bearer eyJ_NEW...

// 4. If refresh fails (refresh token expired)
// -> Clear tokens
// -> Show notice: "Session expired. Please log in again."
// -> User must re-enter credentials
```

## Security Considerations

### Desktop (High Security)

✅ OS-level encryption via Electron safeStorage
✅ Keys managed by OS keychain systems
✅ Automatic encryption/decryption
✅ Protected by user's OS password

### Mobile (Basic Security)

⚠️ XOR obfuscation only (not cryptographic)
⚠️ Warning shown to users
⚠️ Tokens visible to anyone with file access
✅ Recommended: Use desktop app for sensitive data

### Token Lifecycle

- **Access Token**: 24 hours validity
- **Refresh Token**: 90 days validity (server-configured)
- **Auto-refresh**: 23 hours (1 hour before expiry)
- **Manual refresh**: Available via settings UI

## Migration Guide

### From Old Plugin Version

1. **Automatic Migration**:
   - Existing `apiToken` continues to work
   - First API call initializes TokenManager
   - Refresh token saved on next successful request

2. **Manual Setup** (if issues):
   - Go to settings
   - Click "Test Connection"
   - If fails, re-enter API token
   - Token manager initializes automatically

### For New Installations

1. Enter API URL and API token in settings
2. Click "Test Connection" to verify
3. TokenManager automatically initializes
4. Check "Token Status" to see expiry time

## Testing

### Manual Testing

1. **Token Refresh**:
   - Go to settings
   - Click "Refresh Now" button
   - Verify "Success" message
   - Check updated expiry time

2. **Auto-Refresh**:
   - Wait until < 1 hour to expiry
   - Make any API call (sync, etc.)
   - Token automatically refreshes
   - Silent success notification

3. **Storage Method**:
   - Check "Token Storage" in settings
   - Desktop should show "Secure (OS Keychain)"
   - Mobile shows "Basic (Obfuscated)"

### Automated Testing

```typescript
// Test token storage
describe('TokenStorage', () => {
    it('stores and retrieves tokens securely')
    it('handles corrupted data gracefully')
    it('clears tokens completely')
})

// Test token manager
describe('TokenManager', () => {
    it('auto-refreshes before expiry')
    it('handles 401 with refresh + retry')
    it('schedules background refresh')
    it('clears tokens on refresh failure')
})

// Test API client integration
describe('ApiClient', () => {
    it('retries 401 errors automatically')
    it('uses fresh tokens for requests')
    it('handles logout cleanly')
})
```

## Troubleshooting

### Token Refresh Fails

**Symptoms**: "Failed to refresh authentication token"

**Solutions**:
1. Check internet connection
2. Verify server is accessible
3. Check refresh token hasn't expired (90 days)
4. Re-enter API token in settings

### Storage Method Shows "Basic"

**Symptoms**: Token Storage shows "Basic (Obfuscated)"

**Context**: Running on mobile or Electron safeStorage unavailable

**Solutions**:
1. Use desktop app for better security
2. Understand tokens are not fully encrypted
3. Avoid using on shared devices

### Auto-Refresh Not Working

**Symptoms**: Still getting logged out after 24 hours

**Solutions**:
1. Check settings for token expiry time
2. Click "Refresh Now" to test manually
3. Check console for errors
4. Verify background task is running

## Future Enhancements

- [ ] Login flow with email/password in plugin
- [ ] Remember me checkbox
- [ ] Multiple account support
- [ ] Token revocation from settings
- [ ] Biometric authentication (mobile)
