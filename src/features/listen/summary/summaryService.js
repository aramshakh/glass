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
        
        // Initialize cumulative stats
        this.cumulativeStats = {
            me: { observations: 0, evaluations: 0 },
            them: { observations: 0, evaluations: 0 }
        };

        // Initialize filter stats
        this.filterStats = {
            total: 0,
            filtered: 0,
            suspicious: [],
            reasons: {
                tooShort: 0,
                tooLong: 0,
                repetitiveChars: 0,
                excessiveVowels: 0,
                excessiveConsonants: 0,
                randomSymbols: 0,
                numbersOnly: 0,
                symbolsOnly: 0
            }
        };
    }

    setCallbacks({ onAnalysisComplete, onStatusUpdate }) {
        this.onAnalysisComplete = onAnalysisComplete;
        this.onStatusUpdate = onStatusUpdate;
    }

    setSessionId(sessionId) {
        console.log(`🔍 DEBUG: setSessionId called with: ${sessionId}`);
        console.log(`🔍 DEBUG: Previous sessionId: ${this.currentSessionId}`);
        this.currentSessionId = sessionId;
        console.log(`🔍 DEBUG: New sessionId set: ${this.currentSessionId}`);
    }

    sendToRenderer(channel, data) {
        console.log(`🔍 DEBUG: sendToRenderer called with channel: ${channel}`);
        console.log(`🔍 DEBUG: Data type: ${typeof data}, Data keys:`, data ? Object.keys(data) : 'null');
        
        const { windowPool } = require('../../../window/windowManager');
        const listenWindow = windowPool?.get('listen');
        
        if (listenWindow && !listenWindow.isDestroyed()) {
            console.log(`🔍 DEBUG: Listen window found and not destroyed, sending data`);
            listenWindow.webContents.send(channel, data);
        } else {
            console.log(`🔍 DEBUG: Listen window not available or destroyed`);
        }
    }

    addConversationTurn(speaker, text) {
        const conversationText = `${speaker.toLowerCase()}: ${text.trim()}`;
        this.conversationHistory.push(conversationText);
        console.log(`💬 Added conversation text: ${conversationText}`);
        console.log(`📈 Total conversation history: ${this.conversationHistory.length} texts`);
        console.log(`🔍 DEBUG: Speaker: ${speaker}, Text length: ${text.length}, Trimmed: ${text.trim().length}`);

        // Trigger analysis if needed
        this.triggerAnalysisIfNeeded();
    }

    getConversationHistory() {
        return this.conversationHistory;
    }

    resetConversationHistory() {
        console.log(`🔍 DEBUG: resetConversationHistory called`);
        console.log(`🔍 DEBUG: Before reset - conversationHistory length: ${this.conversationHistory.length}`);
        console.log(`🔍 DEBUG: Before reset - cumulativeStats:`, this.cumulativeStats);
        console.log(`🔍 DEBUG: Before reset - filterStats:`, this.filterStats);
        
        this.conversationHistory = [];
        this.previousAnalysisResult = null;
        this.analysisHistory = [];
        // Сброс накопительной статистики
        this.cumulativeStats = {
            me: { observations: 0, evaluations: 0 },
            them: { observations: 0, evaluations: 0 }
        };

        // Сброс статистики фильтрации
        this.filterStats = {
            total: 0,
            filtered: 0,
            suspicious: [],
            reasons: {
                tooShort: 0,
                tooLong: 0,
                repetitiveChars: 0,
                excessiveVowels: 0,
                excessiveConsonants: 0,
                randomSymbols: 0,
                numbersOnly: 0,
                symbolsOnly: 0
            }
        };
        console.log('🔄 Conversation history and analysis state reset');
        console.log(`🔍 DEBUG: After reset - conversationHistory length: ${this.conversationHistory.length}`);
        console.log(`🔍 DEBUG: After reset - cumulativeStats:`, this.cumulativeStats);
        console.log(`🔍 DEBUG: After reset - filterStats:`, this.filterStats);
    }

    // Обновление накопительной статистики
    updateCumulativeStats(userStats) {
        console.log(`🔍 DEBUG: updateCumulativeStats called with:`, userStats);
        console.log(`🔍 DEBUG: Current cumulative stats before update:`, this.cumulativeStats);
        
        if (userStats && userStats.me) {
            this.cumulativeStats.me.observations += userStats.me.observations.length;
            this.cumulativeStats.me.evaluations += userStats.me.evaluations.length;
            console.log(`🔍 DEBUG: Updated me stats - observations: +${userStats.me.observations.length}, evaluations: +${userStats.me.evaluations.length}`);
        }
        if (userStats && userStats.them) {
            this.cumulativeStats.them.observations += userStats.them.evaluations.length;
            this.cumulativeStats.them.evaluations += userStats.them.evaluations.length;
            console.log(`🔍 DEBUG: Updated them stats - observations: +${userStats.them.observations.length}, evaluations: +${userStats.them.evaluations.length}`);
        }
        
        console.log('📊 Cumulative stats updated:', this.cumulativeStats);
    }

    // Фильтрация подозрительных транскриптов (STT галлюцинации)
    filterValidTranscripts(transcripts) {
        console.log(`🔍 DEBUG: filterValidTranscripts called with ${transcripts.length} transcripts`);
        
        if (!transcripts || transcripts.length === 0) {
            console.log(`🔍 DEBUG: No transcripts to filter`);
            return [];
        }

        const filtered = [];
        const filteredOut = [];

        transcripts.forEach((t, index) => {
            console.log(`🔍 DEBUG: Processing transcript ${index + 1}/${transcripts.length}:`, { id: t.id, speaker: t.speaker, text: t.text?.substring(0, 50) + '...' });
            
            if (!t.text || typeof t.text !== 'string') {
                console.log(`🔍 DEBUG: Transcript ${index + 1} - invalid type, filtering out`);
                filteredOut.push({ transcript: t, reason: 'invalidType' });
                return;
            }

            const text = t.text.trim();
            let reason = null;
            
            // Минимальная и максимальная длина
            if (text.length < 3) {
                reason = 'tooShort';
            } else if (text.length > 200) {
                reason = 'tooLong';
            }
            // Проверка на повторяющиеся символы (более 5 подряд)
            else if (/(.)\1{5,}/.test(text)) {
                reason = 'repetitiveChars';
            }
            // Проверка на чрезмерные гласные
            else if (/[aeiou]{8,}/.test(text.toLowerCase())) {
                reason = 'excessiveVowels';
            }
            // Проверка на чрезмерные согласные
            else if (/[bcdfghjklmnpqrstvwxz]{8,}/.test(text.toLowerCase())) {
                reason = 'excessiveConsonants';
            }
            // Проверка на случайные символы и пунктуацию
            else if (/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]{3,}/.test(text)) {
                reason = 'randomSymbols';
            }
            // Проверка на числа (возможно, не речь)
            else if (/^\d+$/.test(text)) {
                reason = 'numbersOnly';
            }
            // Проверка на специальные символы (возможно, не речь)
            else if (/^[^\w\s]+$/.test(text)) {
                reason = 'symbolsOnly';
            }

            if (reason) {
                console.log(`🔍 DEBUG: Transcript ${index + 1} filtered out - reason: ${reason}`);
                filteredOut.push({ transcript: t, reason });
                this.filterStats.reasons[reason]++;
            } else {
                console.log(`🔍 DEBUG: Transcript ${index + 1} passed filtering`);
                filtered.push(t);
            }
        });

        // Обновляем статистику фильтрации
        this.filterStats.total += transcripts.length;
        this.filterStats.filtered += filteredOut.length;
        this.filterStats.suspicious.push(...filteredOut.map(item => ({ 
            id: item.transcript.id, 
            text: item.transcript.text, 
            reason: item.reason,
            timestamp: Date.now() 
        })));

        if (filteredOut.length > 0) {
            console.log('🚫 Filtered out suspicious transcripts:');
            filteredOut.forEach(item => {
                console.log(`   - "${item.transcript.text}" (${item.reason})`);
            });
        }

        // Детальная статистика по причинам
        const reasonsSummary = Object.entries(this.filterStats.reasons)
            .filter(([_, count]) => count > 0)
            .map(([reason, count]) => `${reason}: ${count}`)
            .join(', ');

        console.log(`✅ Transcript filtering: ${transcripts.length} → ${filtered.length} (filtered out: ${filteredOut.length})`);
        if (reasonsSummary) {
            console.log(`📊 Filter reasons: ${reasonsSummary}`);
        }
        
        return filtered;
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
        console.log(`🔍 DEBUG: classifyConversation called with ${transcripts.length} transcripts`);
        
        if (!transcripts || transcripts.length === 0) {
            console.log(`🔍 DEBUG: No transcripts to classify`);
            return null;
        }

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

            console.log(`🔍 DEBUG: Sending classification request with ${transcripts.length} transcripts`);
            console.log(`🔍 DEBUG: Request payload:`, messages[1].content);
            console.log(`🔍 DEBUG: All transcripts being sent:`, transcripts.map(t => ({ id: t.id, speaker: t.speaker, text: t.text })));

            const completion = await llm.chat(messages);
            const responseText = completion.content;
            console.log(`✅ Classification response received: ${responseText}`);
            
            const parsedResponse = JSON.parse(responseText);
            console.log(`🔍 DEBUG: Parsed response:`, parsedResponse);
            
            return parsedResponse;
        } catch (error) {
            console.error('❌ Error during classification:', error.message);
            return null;
        }
    }

    parseClassificationResult(result, transcripts) {
        console.log(`🔍 DEBUG: parseClassificationResult called with:`, { result, transcriptsCount: transcripts.length });
        
        const userStats = {
            me: { observations: [], evaluations: [] },
            them: { observations: [], evaluations: [] }
        };

        if (!result || !Array.isArray(result.transcripts)) {
            console.log(`🔍 DEBUG: Invalid result format:`, result);
            return { userStats };
        }

        console.log(`🔍 DEBUG: Processing ${result.transcripts.length} classification items`);
        
        // Отслеживаем пропущенные транскрипты
        const processedIds = new Set();
        
        for (const item of result.transcripts) {
            console.log(`🔍 DEBUG: Processing item:`, item);
            const target = transcripts.find(t => t.id === item.id);
            console.log(`🔍 DEBUG: Found target transcript:`, target ? { id: target.id, speaker: target.speaker, text: target.text?.substring(0, 50) + '...' } : 'NOT FOUND');
            
            if (target) {
                processedIds.add(target.id);
                target.nvc_type = item.nvc_type;
                const speaker = target.speaker.toLowerCase();
                const userKey = speaker === 'me' ? 'me' : 'them';
                console.log(`🔍 DEBUG: Speaker: ${speaker}, UserKey: ${userKey}, NVC Type: ${item.nvc_type}`);
                
                if (item.nvc_type === 'observation') {
                    userStats[userKey].observations.push(target.text);
                    console.log(`🔍 DEBUG: Added observation for ${userKey}:`, target.text?.substring(0, 50) + '...');
                } else if (item.nvc_type === 'evaluation') {
                    userStats[userKey].evaluations.push(target.text);
                    console.log(`🔍 DEBUG: Added evaluation for ${userKey}:`, target.text?.substring(0, 50) + '...');
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
        
        // Проверяем пропущенные транскрипты
        const missingTranscripts = transcripts.filter(t => !processedIds.has(t.id));
        if (missingTranscripts.length > 0) {
            console.log(`⚠️ WARNING: ${missingTranscripts.length} transcripts were NOT classified by AI:`);
            missingTranscripts.forEach(t => {
                console.log(`   - ID: ${t.id}, Speaker: ${t.speaker}, Text: "${t.text?.substring(0, 50)}..."`);
            });
        }

        console.log(`🔍 DEBUG: Final userStats:`, userStats);
        return { userStats };
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
                    console.log(`🔍 DEBUG: Total transcripts in session: ${allTranscripts.length}`);
                    console.log(`🔍 DEBUG: All transcripts:`, allTranscripts.map(t => ({ id: t.id, speaker: t.speaker, text: t.text?.substring(0, 50) + '...' })));
                    
                    const recentTranscripts = allTranscripts.slice(-5);
                    console.log(`🔍 DEBUG: Recent 5 transcripts:`, recentTranscripts.map(t => ({ id: t.id, speaker: t.speaker, text: t.text?.substring(0, 50) + '...' })));
                    
                    // Применяем фильтр для удаления STT галлюцинаций
                    const filteredTranscripts = this.filterValidTranscripts(recentTranscripts);
                    console.log(`🔍 DEBUG: After filtering: ${filteredTranscripts.length} transcripts`);
                    console.log(`🔍 DEBUG: Filtered transcripts:`, filteredTranscripts.map(t => ({ id: t.id, speaker: t.speaker, text: t.text?.substring(0, 50) + '...' })));
                    
                    if (filteredTranscripts.length > 0) {
                        console.log(`🔍 DEBUG: Starting classification with ${filteredTranscripts.length} transcripts`);
                        const classificationResult = await this.classifyConversation(filteredTranscripts);
                        console.log(`🔍 DEBUG: Classification result:`, classificationResult);
                        classificationData = this.parseClassificationResult(
                            classificationResult,
                            filteredTranscripts
                        );
                        console.log(`🔍 DEBUG: Parsed classification data:`, classificationData);
                    } else {
                        console.log('⚠️ No valid transcripts after filtering, skipping classification');
                    }
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

    // Получить статистику фильтрации
    getFilterStats() {
        return this.filterStats;
    }

    // Получить детальную статистику фильтрации
    getDetailedFilterStats() {
        console.log(`🔍 DEBUG: getDetailedFilterStats called with current filterStats:`, this.filterStats);
        
        const stats = { ...this.filterStats };
        
        // Добавляем процентные показатели
        if (stats.total > 0) {
            stats.filterRate = Math.round((stats.filtered / stats.total) * 100);
            stats.validRate = 100 - stats.filterRate;
        } else {
            stats.filterRate = 0;
            stats.validRate = 100;
        }

        // Добавляем топ причин фильтрации
        stats.topReasons = Object.entries(stats.reasons)
            .filter(([_, count]) => count > 0)
            .sort(([_, a], [__, b]) => b - a)
            .slice(0, 3)
            .map(([reason, count]) => ({ reason, count }));

        console.log(`🔍 DEBUG: Computed detailed stats:`, stats);
        return stats;
    }

    // Логировать текущую статистику фильтрации
    logFilterStats() {
        const stats = this.getDetailedFilterStats();
        console.log('📊 Current Filter Statistics:');
        console.log(`   Total transcripts: ${stats.total}`);
        console.log(`   Valid: ${stats.total - stats.filtered} (${stats.validRate}%)`);
        console.log(`   Filtered: ${stats.filtered} (${stats.filterRate}%)`);
        
        if (stats.topReasons.length > 0) {
            console.log('   Top filter reasons:');
            stats.topReasons.forEach(({ reason, count }) => {
                console.log(`     - ${reason}: ${count}`);
            });
        }
        
        console.log(`🔍 DEBUG: Full filter stats object:`, this.filterStats);
        console.log(`🔍 DEBUG: Suspicious transcripts:`, this.filterStats.suspicious);
    }
}

module.exports = SummaryService; 