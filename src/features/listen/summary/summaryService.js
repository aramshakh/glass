const { BrowserWindow } = require('electron');
const { getSystemPrompt } = require('../../common/prompts/promptBuilder.js');
const { createLLM } = require('../../common/ai/factory');
const sessionRepository = require('../../common/repositories/session');
const summaryRepository = require('./repositories');
const modelStateService = require('../../common/services/modelStateService');
const sttRepository = require('../stt/repositories');
const { CLASSIFICATION_PROMPT } = require('../../common/prompts/promptTemplates.js');

class SummaryService {
    constructor() {
        this.previousAnalysisResult = null;
        this.analysisHistory = [];
        this.conversationHistory = [];
        this.currentSessionId = null;
        
        // Callbacks
        this.onAnalysisComplete = null;
        this.onStatusUpdate = null;
    }

    setCallbacks({ onAnalysisComplete, onStatusUpdate }) {
        this.onAnalysisComplete = onAnalysisComplete;
        this.onStatusUpdate = onStatusUpdate;
    }

    setSessionId(sessionId) {
        this.currentSessionId = sessionId;
    }

    sendToRenderer(channel, data) {
        const { windowPool } = require('../../../window/windowManager');
        const listenWindow = windowPool?.get('listen');
        
        if (listenWindow && !listenWindow.isDestroyed()) {
            listenWindow.webContents.send(channel, data);
        }
    }

    addConversationTurn(speaker, text) {
        const conversationText = `${speaker.toLowerCase()}: ${text.trim()}`;
        this.conversationHistory.push(conversationText);
        console.log(`💬 Added conversation text: ${conversationText}`);
        console.log(`📈 Total conversation history: ${this.conversationHistory.length} texts`);

        // Trigger analysis if needed
        this.triggerAnalysisIfNeeded();
    }

    getConversationHistory() {
        return this.conversationHistory;
    }

    resetConversationHistory() {
        this.conversationHistory = [];
        this.previousAnalysisResult = null;
        this.analysisHistory = [];
        console.log('🔄 Conversation history and analysis state reset');
    }

    /**
     * Converts conversation history into text to include in the prompt.
     * @param {Array<string>} conversationTexts - Array of conversation texts ["me: ~~~", "them: ~~~", ...]
     * @param {number} maxTurns - Maximum number of recent turns to include
     * @returns {string} - Formatted conversation string for the prompt
     */
    formatConversationForPrompt(conversationTexts, maxTurns = 30) {
        if (conversationTexts.length === 0) return '';
        return conversationTexts.slice(-maxTurns).join('\n');
    }

    async makeOutlineAndRequests(conversationTexts, maxTurns = 30) {
        console.log(`🔍 makeOutlineAndRequests called - conversationTexts: ${conversationTexts.length}`);

        if (conversationTexts.length === 0) {
            console.log('⚠️ No conversation texts available for analysis');
            return null;
        }

        const recentConversation = this.formatConversationForPrompt(conversationTexts, maxTurns);

        // 이전 분석 결과를 프롬프트에 포함
        let contextualPrompt = '';
        if (this.previousAnalysisResult) {
            contextualPrompt = `
Previous Analysis Context:
- Main Topic: ${this.previousAnalysisResult.topic.header}
- Key Points: ${this.previousAnalysisResult.summary.slice(0, 3).join(', ')}
- Last Actions: ${this.previousAnalysisResult.actions.slice(0, 2).join(', ')}

Please build upon this context while analyzing the new conversation segments.
`;
        }

        const basePrompt = getSystemPrompt('pickle_glass_analysis', '', false);
        const systemPrompt = basePrompt.replace('{{CONVERSATION_HISTORY}}', recentConversation);

        try {
            if (this.currentSessionId) {
                await sessionRepository.touch(this.currentSessionId);
            }

            const modelInfo = await modelStateService.getCurrentModelInfo('llm');
            if (!modelInfo || !modelInfo.apiKey) {
                throw new Error('AI model or API key is not configured.');
            }
            console.log(`🤖 Sending analysis request to ${modelInfo.provider} using model ${modelInfo.model}`);
            
            const messages = [
                {
                    role: 'system',
                    content: systemPrompt,
                },
                {
                    role: 'user',
                    content: `${contextualPrompt}

Analyze the conversation and provide a structured summary. Format your response as follows:

**Summary Overview**
- Main discussion point with context

**Key Topic: [Topic Name]**
- First key insight
- Second key insight
- Third key insight

**Extended Explanation**
Provide 2-3 sentences explaining the context and implications.

**Suggested Questions**
1. First follow-up question?
2. Second follow-up question?
3. Third follow-up question?

Keep all points concise and build upon previous analysis if provided.`,
                },
            ];

            console.log('🤖 Sending analysis request to AI...');

            const llm = createLLM(modelInfo.provider, {
                apiKey: modelInfo.apiKey,
                model: modelInfo.model,
                temperature: 0.7,
                maxTokens: 1024,
                usePortkey: modelInfo.provider === 'openai-glass',
                portkeyVirtualKey: modelInfo.provider === 'openai-glass' ? modelInfo.apiKey : undefined,
            });

            const completion = await llm.chat(messages);

            const responseText = completion.content;
            console.log(`✅ Analysis response received: ${responseText}`);
            const structuredData = this.parseResponseText(responseText, this.previousAnalysisResult);

            if (this.currentSessionId) {
                try {
                    summaryRepository.saveSummary({
                        sessionId: this.currentSessionId,
                        text: responseText,
                        tldr: structuredData.summary.join('\n'),
                        bullet_json: JSON.stringify(structuredData.topic.bullets),
                        action_json: JSON.stringify(structuredData.actions),
                        model: modelInfo.model
                    });
                } catch (err) {
                    console.error('[DB] Failed to save summary:', err);
                }
            }

            // 분석 결과 저장
            this.previousAnalysisResult = structuredData;
            this.analysisHistory.push({
                timestamp: Date.now(),
                data: structuredData,
                conversationLength: conversationTexts.length,
            });

            if (this.analysisHistory.length > 10) {
                this.analysisHistory.shift();
            }

            return structuredData;
        } catch (error) {
            console.error('❌ Error during analysis generation:', error.message);
            return this.previousAnalysisResult; // 에러 시 이전 결과 반환
        }
    }

    parseResponseText(responseText, previousResult) {
        const structuredData = {
            summary: [],
            topic: { header: '', bullets: [] },
            actions: [],
            followUps: ['✉️ Draft a follow-up email', '✅ Generate action items', '📝 Show summary'],
        };

        // 이전 결과가 있으면 기본값으로 사용
        if (previousResult) {
            structuredData.topic.header = previousResult.topic.header;
            structuredData.summary = [...previousResult.summary];
        }

        try {
            const lines = responseText.split('\n');
            let currentSection = '';
            let isCapturingTopic = false;
            let topicName = '';

            for (const line of lines) {
                const trimmedLine = line.trim();

                // 섹션 헤더 감지
                if (trimmedLine.startsWith('**Summary Overview**')) {
                    currentSection = 'summary-overview';
                    continue;
                } else if (trimmedLine.startsWith('**Key Topic:')) {
                    currentSection = 'topic';
                    isCapturingTopic = true;
                    topicName = trimmedLine.match(/\*\*Key Topic: (.+?)\*\*/)?.[1] || '';
                    if (topicName) {
                        structuredData.topic.header = topicName + ':';
                    }
                    continue;
                } else if (trimmedLine.startsWith('**Extended Explanation**')) {
                    currentSection = 'explanation';
                    continue;
                } else if (trimmedLine.startsWith('**Suggested Questions**')) {
                    currentSection = 'questions';
                    continue;
                }

                // 컨텐츠 파싱
                if (trimmedLine.startsWith('-') && currentSection === 'summary-overview') {
                    const summaryPoint = trimmedLine.substring(1).trim();
                    if (summaryPoint && !structuredData.summary.includes(summaryPoint)) {
                        // 기존 summary 업데이트 (최대 5개 유지)
                        structuredData.summary.unshift(summaryPoint);
                        if (structuredData.summary.length > 5) {
                            structuredData.summary.pop();
                        }
                    }
                } else if (trimmedLine.startsWith('-') && currentSection === 'topic') {
                    const bullet = trimmedLine.substring(1).trim();
                    if (bullet && structuredData.topic.bullets.length < 3) {
                        structuredData.topic.bullets.push(bullet);
                    }
                } else if (currentSection === 'explanation' && trimmedLine) {
                    // explanation을 topic bullets에 추가 (문장 단위로)
                    const sentences = trimmedLine
                        .split(/\.\s+/)
                        .filter(s => s.trim().length > 0)
                        .map(s => s.trim() + (s.endsWith('.') ? '' : '.'));

                    sentences.forEach(sentence => {
                        if (structuredData.topic.bullets.length < 3 && !structuredData.topic.bullets.includes(sentence)) {
                            structuredData.topic.bullets.push(sentence);
                        }
                    });
                } else if (trimmedLine.match(/^\d+\./) && currentSection === 'questions') {
                    const question = trimmedLine.replace(/^\d+\.\s*/, '').trim();
                    if (question && question.includes('?')) {
                        structuredData.actions.push(`❓ ${question}`);
                    }
                }
            }

            // 기본 액션 추가
            const defaultActions = ['✨ What should I say next?', '💬 Suggest follow-up questions'];
            defaultActions.forEach(action => {
                if (!structuredData.actions.includes(action)) {
                    structuredData.actions.push(action);
                }
            });

            // 액션 개수 제한
            structuredData.actions = structuredData.actions.slice(0, 5);

            // 유효성 검증 및 이전 데이터 병합
            if (structuredData.summary.length === 0 && previousResult) {
                structuredData.summary = previousResult.summary;
            }
            if (structuredData.topic.bullets.length === 0 && previousResult) {
                structuredData.topic.bullets = previousResult.topic.bullets;
            }
        } catch (error) {
            console.error('❌ Error parsing response text:', error);
            // 에러 시 이전 결과 반환
            return (
                previousResult || {
                    summary: [],
                    topic: { header: 'Analysis in progress', bullets: [] },
                    actions: ['✨ What should I say next?', '💬 Suggest follow-up questions'],
                    followUps: ['✉️ Draft a follow-up email', '✅ Generate action items', '📝 Show summary'],
                }
            );
        }

        console.log('📊 Final structured data:', JSON.stringify(structuredData, null, 2));
        return structuredData;
    }

    async classifyConversation(transcripts) {
        if (!transcripts || transcripts.length === 0) return null;

        try {
            const modelInfo = await modelStateService.getCurrentModelInfo('llm');
            if (!modelInfo || !modelInfo.apiKey) {
                throw new Error('AI model or API key is not configured.');
            }

            const llm = createLLM(modelInfo.provider, {
                apiKey: modelInfo.apiKey,
                model: modelInfo.model,
                temperature: 0,
                maxTokens: 512,
                usePortkey: modelInfo.provider === 'openai-glass',
                portkeyVirtualKey:
                    modelInfo.provider === 'openai-glass' ? modelInfo.apiKey : undefined,
            });

            const messages = [
                { role: 'system', content: CLASSIFICATION_PROMPT },
                {
                    role: 'user',
                    content: JSON.stringify({
                        transcripts: transcripts.map(t => ({ id: t.id, text: t.text })),
                    }),
                },
            ];

            const completion = await llm.chat(messages);
            const responseText = completion.content;
            console.log(`✅ Classification response received: ${responseText}`);
            return JSON.parse(responseText);
        } catch (error) {
            console.error('❌ Error during classification:', error.message);
            return null;
        }
    }

    parseClassificationResult(result, transcripts) {
        const observations = [];
        const evaluations = [];

        if (!result || !Array.isArray(result.transcripts)) {
            return { observations, evaluations };
        }

        for (const item of result.transcripts) {
            const target = transcripts.find(t => t.id === item.id);
            if (target) {
                target.nvc_type = item.nvc_type;
                if (item.nvc_type === 'observation') {
                    observations.push(target.text);
                } else if (item.nvc_type === 'evaluation') {
                    evaluations.push(target.text);
                }

                try {
                    sttRepository.updateTranscriptType(
                        target.session_id,
                        target.id,
                        target.nvc_type
                    );
                } catch (err) {
                    console.error('Error updating transcript type:', err);
                }
            }
        }

        return { observations, evaluations };
    }

    /**
     * Triggers analysis when conversation history reaches 5 texts.
     */
    async triggerAnalysisIfNeeded() {
        if (this.conversationHistory.length >= 5 && this.conversationHistory.length % 5 === 0) {
            console.log(
                `Triggering analysis - ${this.conversationHistory.length} conversation texts accumulated`
            );

            const data = await this.makeOutlineAndRequests(this.conversationHistory);

            let classificationData = { observations: [], evaluations: [] };

            try {
                if (this.currentSessionId) {
                    const allTranscripts = await sttRepository.getAllTranscriptsBySessionId(
                        this.currentSessionId
                    );
                    const recentTranscripts = allTranscripts.slice(-5);
                    const classificationResult = await this.classifyConversation(recentTranscripts);
                    classificationData = this.parseClassificationResult(
                        classificationResult,
                        recentTranscripts
                    );
                }
            } catch (err) {
                console.error('❌ Error during conversation classification:', err.message);
            }

            if (data) {
                const merged = { ...data, ...classificationData };
                console.log('Sending structured data to renderer');
                this.sendToRenderer('summary-update', merged);

                // Notify callback
                if (this.onAnalysisComplete) {
                    this.onAnalysisComplete(merged);
                }
            } else {
                console.log('No analysis data returned');
            }
        }
    }

    getCurrentAnalysisData() {
        return {
            previousResult: this.previousAnalysisResult,
            history: this.analysisHistory,
            conversationLength: this.conversationHistory.length,
        };
    }
}

module.exports = SummaryService; 