#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, } from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
// Add request/response interceptors for debugging
axios.interceptors.request.use(request => {
    console.error('Request:', {
        method: request.method,
        url: request.url,
        headers: request.headers,
        params: request.params
    });
    return request;
});
axios.interceptors.response.use(response => {
    console.error('Response:', {
        status: response.status,
        data: response.data
    });
    return response;
}, error => {
    console.error('Error:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message
    });
    return Promise.reject(error);
});
class OutlineServer {
    server;
    apiKey;
    instanceUrl;
    constructor() {
        this.server = new Server({
            name: 'outline-server',
            version: '0.1.0',
        }, {
            capabilities: {
                tools: {},
            },
        });
        this.apiKey = process.env.OUTLINE_API_KEY || '';
        this.instanceUrl = process.env.OUTLINE_INSTANCE_URL || '';
        if (!this.apiKey || !this.instanceUrl) {
            throw new Error('OUTLINE_API_KEY and OUTLINE_INSTANCE_URL environment variables are required');
        }
        this.setupToolHandlers();
        this.server.onerror = (error) => console.error('[MCP Error]', error);
        process.on('SIGINT', async () => {
            await this.server.close();
            process.exit(0);
        });
    }
    extractKeywords(query) {
        // Remove common words and keep only significant terms
        const stopWords = ['how', 'do', 'i', 'to', 'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'what', 'where', 'when', 'why', 'which', 'who', 'whom', 'whose', 'can', 'could', 'should', 'would', 'will'];
        return query
            .toLowerCase()
            .split(/\s+/)
            .filter(word => word.length > 2 &&
            !stopWords.includes(word) &&
            !word.match(/^[^a-zA-Z0-9]+$/) // Remove words that are just punctuation
        );
    }
    async getDocument(documentId) {
        try {
            const baseUrl = this.instanceUrl.replace(/\/$/, '');
            const response = await axios.post(`${baseUrl}/api/documents.info`, {
                id: documentId
            }, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                }
            });
            return response.data.data;
        }
        catch (error) {
            console.error('Error fetching document:', error);
            return null;
        }
    }
    async searchDocuments(query, topK = 3, maxChars = 4000) {
        try {
            console.error(`Making request to: ${this.instanceUrl}/api/documents.search`);
            console.error('Using API key:', this.apiKey);
            // Extract keywords for initial search
            const keywords = this.extractKeywords(query);
            console.error('Extracted keywords:', keywords);
            // Try different keyword combinations until we find results
            let documents = [];
            for (let i = 0; i < keywords.length && documents.length === 0; i++) {
                const searchTerm = keywords[i];
                console.error('Trying search term:', searchTerm);
                const baseUrl = this.instanceUrl.replace(/\/$/, '');
                const response = await axios.post(`${baseUrl}/api/documents.search`, {
                    query: searchTerm,
                    limit: topK,
                    offset: 0,
                    statusFilter: ["published"]
                }, {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    }
                });
                if (response.data.data && Array.isArray(response.data.data)) {
                    const results = await Promise.all(response.data.data.map(async (result) => {
                        const doc = result.document;
                        const fullDoc = await this.getDocument(doc.id);
                        return {
                            id: doc.id || '',
                            title: doc.title || '',
                            text: fullDoc ? (fullDoc.text || '').substring(0, maxChars) : (result.context || '').substring(0, maxChars),
                            url: `${this.instanceUrl}/doc/${doc.urlId || doc.id || ''}`,
                        };
                    }));
                    documents = documents.concat(results);
                }
            }
            console.error(`Found ${documents.length} documents`);
            return documents;
        }
        catch (error) {
            if (axios.isAxiosError(error)) {
                console.error('Full error response:', error.response?.data);
                throw new McpError(ErrorCode.InternalError, `Outline API error: ${error.response?.data?.message || error.message} (URL: ${this.instanceUrl})`);
            }
            throw error;
        }
    }
    setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'search_documents',
                    description: 'Search for documents in your Outline wiki instance',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            query: {
                                type: 'string',
                                description: 'Search query',
                            },
                            top_k: {
                                type: 'number',
                                description: 'Number of documents to return (default: 3)',
                                minimum: 1,
                                maximum: 10,
                            },
                            max_chars: {
                                type: 'number',
                                description: 'Maximum number of characters per document (default: 4000)',
                                minimum: 100,
                                maximum: 10000,
                            },
                        },
                        required: ['query'],
                    },
                },
            ],
        }));
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            if (request.params.name !== 'search_documents') {
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
            }
            if (!request.params.arguments || typeof request.params.arguments !== 'object') {
                throw new McpError(ErrorCode.InvalidParams, 'Arguments must be an object');
            }
            const args = request.params.arguments;
            if (typeof args.query !== 'string') {
                throw new McpError(ErrorCode.InvalidParams, 'Query must be a string');
            }
            const query = args.query;
            const top_k = typeof args.top_k === 'number' ? args.top_k : 3;
            const max_chars = typeof args.max_chars === 'number' ? args.max_chars : 4000;
            try {
                const documents = await this.searchDocuments(query, top_k, max_chars);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(documents, null, 2),
                        },
                    ],
                };
            }
            catch (error) {
                if (error instanceof McpError) {
                    throw error;
                }
                throw new McpError(ErrorCode.InternalError, `Failed to search documents: ${error}`);
            }
        });
    }
    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('Outline MCP server running on stdio');
    }
}
const server = new OutlineServer();
server.run().catch(console.error);
