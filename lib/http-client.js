import { debugLog, errorLog } from './utils';
export class HttpClient {
    constructor(endpoint, config) {
        this.lastRequestTime = 0;
        this.requestCount = 0;
        this.endpoint = endpoint;
        this.config = config;
    }
    /**
     * Send a single event with retry logic
     */
    async sendEvent(payload) {
        return this.sendWithRetry(payload, 0);
    }
    /**
     * Send multiple events in a batch
     */
    async sendBatch(payloads) {
        // For now, send events individually
        // In production, you might want to implement true batching
        return Promise.all(payloads.map(payload => this.sendEvent(payload)));
    }
    /**
     * Send request with exponential backoff retry
     */
    async sendWithRetry(payload, retryCount) {
        try {
            // Basic rate limiting: max 100 requests per minute
            const now = Date.now();
            if (now - this.lastRequestTime < 60000) {
                this.requestCount++;
                if (this.requestCount > 100) {
                    throw new Error('Rate limit exceeded: max 100 requests per minute');
                }
            }
            else {
                this.requestCount = 1;
                this.lastRequestTime = now;
            }
            debugLog(`Sending event: ${payload.eventName} (attempt ${retryCount + 1})`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);
            const headers = {
                'Content-Type': 'application/json',
                'User-Agent': `datalyr-react-native-sdk/1.0.11`,
            };
            // Use workspace ID as Bearer token if no API key provided (matching web script)
            const authToken = this.config.apiKey || this.config.workspaceId;
            headers['Authorization'] = `Bearer ${authToken}`;
            // Add multiple auth methods for compatibility
            if (this.config.apiKey) {
                headers['X-API-Key'] = this.config.apiKey;
                headers['X-Datalyr-API-Key'] = this.config.apiKey;
            }
            const response = await fetch(this.endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (!response.ok) {
                if (response.status === 401) {
                    throw new Error(`HTTP 401: Authentication failed. Check your API key and workspace ID.`);
                }
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            const responseData = await response.json();
            debugLog(`Event sent successfully: ${payload.eventName}`, responseData);
            return {
                success: true,
                status: response.status,
                data: responseData,
            };
        }
        catch (error) {
            errorLog(`Event send failed (attempt ${retryCount + 1}):`, error);
            // Check if we should retry
            if (retryCount < this.config.maxRetries && this.shouldRetry(error)) {
                const delay = this.calculateRetryDelay(retryCount);
                debugLog(`Retrying in ${delay}ms...`);
                await this.delay(delay);
                return this.sendWithRetry(payload, retryCount + 1);
            }
            return {
                success: false,
                status: 0,
                error: error.message,
            };
        }
    }
    /**
     * Determine if an error should trigger a retry
     */
    shouldRetry(error) {
        const retryableErrors = [
            'NetworkError',
            'TimeoutError',
            'AbortError',
            'fetch is not defined', // Fallback for environments without fetch
        ];
        // Don't retry authentication errors (401) or client errors (4xx)
        if (error.message.includes('HTTP 401') || error.message.includes('HTTP 4')) {
            return false;
        }
        // Retry on server errors (5xx) and network issues
        if (error.message.includes('HTTP 5')) {
            return true;
        }
        return retryableErrors.some(retryableError => error.message.includes(retryableError) || error.name === retryableError);
    }
    /**
     * Calculate exponential backoff delay
     */
    calculateRetryDelay(retryCount) {
        const baseDelay = this.config.retryDelay;
        const exponentialDelay = Math.pow(2, retryCount) * baseDelay;
        const jitter = Math.random() * 1000; // Add some jitter to prevent thundering herd
        return Math.min(exponentialDelay + jitter, 30000); // Cap at 30 seconds
    }
    /**
     * Promise-based delay
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    /**
     * Test connectivity to the endpoint
     */
    async testConnection() {
        try {
            const testPayload = {
                workspaceId: 'test',
                visitorId: 'test',
                sessionId: 'test',
                eventId: 'test',
                eventName: 'connection_test',
                source: 'mobile_app',
                timestamp: new Date().toISOString(),
            };
            const response = await this.sendEvent(testPayload);
            return response.success;
        }
        catch (error) {
            errorLog('Connection test failed:', error);
            return false;
        }
    }
    /**
     * Update endpoint URL
     */
    updateEndpoint(endpoint) {
        this.endpoint = endpoint;
        debugLog(`Updated endpoint to: ${endpoint}`);
    }
    /**
     * Update configuration
     */
    updateConfig(config) {
        this.config = { ...this.config, ...config };
        debugLog('Updated HTTP client config:', this.config);
    }
}
/**
 * Default HTTP client factory
 */
export const createHttpClient = (endpoint, config) => {
    const defaultConfig = {
        maxRetries: 3,
        retryDelay: 1000, // 1 second base delay
        timeout: 15000, // 15 seconds
        apiKey: undefined,
        workspaceId: '',
        debug: false,
    };
    return new HttpClient(endpoint, { ...defaultConfig, ...config });
};
