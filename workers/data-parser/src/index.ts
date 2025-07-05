/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { GoogleGenAI } from '@google/genai';
import { SYSTEM_INSTRUCTIONS } from './constants';

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const DOT_TRAFFIC_URL = 'https://www.nyc.gov/html/dot/html/motorist/weektraf.shtml'

		console.log('Fetching DOT traffic data from:', DOT_TRAFFIC_URL)

		try {
			const response = await fetch(DOT_TRAFFIC_URL, {
				headers: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Accept-Charset': 'utf-8',
					'User-Agent': 'Mozilla/5.0 (compatible; NYC Traffic Parser)'
				}
			});

			if (!response.ok) {
				throw new Error(`Failed to fetch data: ${response.status} ${response.statusText}`);
			}

			// Ensure proper UTF-8 decoding
			const buffer = await response.arrayBuffer();
			const html = new TextDecoder('utf-8').decode(buffer);
            const manhattanSection = extractSectionFromHeader(html, 'manhattan');

			// Transform the HTML section into a structured JSON format using Gemini API
			const closuresJson = await callGeminiAPI(env.GEMINI_API_KEY, manhattanSection);

			// Save to R2 bucket
			const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
			await env.nyc_traffic_alerts.put(`manhattan/${currentDate}.json`, closuresJson);

			return new Response('DOT traffic data processed and saved successfully', { status: 200 });
		} catch (error) {
			console.error('Error fetching DOT traffic data:', error);
			const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
			return new Response('Error fetching data: ' + errorMessage, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;

function extractSectionFromHeader(html: string, startId: string): string {
    // Find the start h2 tag
    const startPattern = new RegExp(`<h2[^>]*id=['"]${startId}['"][^>]*>`, 'i');
    const startMatch = html.match(startPattern);
    
    if (!startMatch) {
        return `Section with id "${startId}" not found`;
    }
    
    const startIndex = startMatch.index!;
    
    // Find the next h2 tag (any h2, regardless of ID)
    const nextH2Pattern = /<h2[^>]*>/i;
    const nextH2Match = html.slice(startIndex + startMatch[0].length).match(nextH2Pattern);
    
    if (!nextH2Match) {
        // If no next h2 found, take everything until the end
        return html.slice(startIndex);
    }
    
    const endIndex = startIndex + startMatch[0].length + nextH2Match.index!;
    
    // Extract the content between the headers
    return html.slice(startIndex, endIndex).trim();
}

// Call Gemini API to get structured data of the closures
async function callGeminiAPI(apiKey: string, input: string): Promise<any> {
	if (!apiKey) {
		throw new Error('Gemini API key is not set');
	}

	const ai = new GoogleGenAI({apiKey: apiKey});

	const response = await ai.models.generateContent({
		model: "gemini-2.5-flash",
		contents: input,
		config: {
			systemInstruction: SYSTEM_INSTRUCTIONS,
			// thinkingConfig: {
			// 	thinkingBudget: 0, // disable thinking
			// },
			responseMimeType: "application/json",
			responseSchema: {
				type: "object",
				properties: {
					events: {
						type: "array",
						items: {
							type: "object",
							properties: {
								eventName: { type: "string" },
								eventDate: { type: "string" },
								closures: {
									type: "array",
									items: {
										type: "object",
										properties: {
											type: { type: "string" },
											streets: {
												type: "array",
												items: {
													type: "object",
													properties: {
														startLocation: { type: "string" },
														endLocation: { type: "string" }
													},
													required: ["startLocation", "endLocation"]
												}
											}
										},
										required: ["type", "streets"]
									}
								}
							},
							required: ["eventName", "eventDate", "closures"]
						}
					}
				},
				required: ["events"]
			}
		}
	})

	return response.text
}
