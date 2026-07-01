const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const JSZip = require('jszip');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const clientBuildPath = path.join(__dirname, 'client', 'build');
if (fs.existsSync(clientBuildPath)) {
  app.use(express.static(clientBuildPath));
} else {
  const publicPath = path.join(__dirname, 'public');
  if (fs.existsSync(publicPath)) {
    app.use(express.static(publicPath));
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/webm', 'audio/ogg'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('오디오 파일만 업로드 가능합니다'));
    }
  }
});

app.post('/api/process-text', async (req, res) => {
  try {
    const { transcript, metadata } = req.body;
    if (!transcript || !transcript.trim()) {
      return res.status(400).json({ error: '텍스트를 입력해주세요' });
    }

    const fileId = uuidv4();
    console.log(`📝 텍스트 수신: ${transcript.length}자`);
    console.log('🤖 Gemini API로 정리 중...');
    const insightJson = await organizeInsightWithGemini(transcript, metadata);
    console.log('✓ 정리 완료');

    const result = {
      id: fileId,
      filename: metadata?.source || 'Plaud Note Pro',
      metadata: metadata || {},
      transcript: transcript,
      insightJson: insightJson,
      processedAt: new Date().toISOString()
    };

    const resultDir = './results';
    if (!fs.existsSync(resultDir)) {
      fs.mkdirSync(resultDir);
    }
    const resultPath = path.join(resultDir, `${fileId}.json`);
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf-8');

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('❌ 에러:', error.message);
    res.status(500).json({
      error: error.message,
      hint: 'API Key와 환경설정을 확인하세요'
    });
  }
});

app.post('/api/process-keynote', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '오디오 파일을 선택해주세요' });
    }

    const { metadata } = req.body;
    const filePath = req.file.path;
    const fileId = uuidv4();

    console.log(`📁 파일 수신: ${req.file.originalname}`);
    console.log('🎤 Google Speech-to-Text 변환 중...');
    const transcript = await transcribeAudioWithGoogle(filePath);
    console.log('✓ STT 완료');

    console.log('🤖 Gemini API로 정리 중...');
    const insightJson = await organizeInsightWithGemini(transcript, metadata);
    console.log('✓ 정리 완료');

    const result = {
      id: fileId,
      filename: req.file.originalname,
      metadata: metadata ? JSON.parse(metadata) : {},
      transcript: transcript,
      insightJson: insightJson,
      processedAt: new Date().toISOString()
    };

    const resultDir = './results';
    if (!fs.existsSync(resultDir)) {
      fs.mkdirSync(resultDir);
    }
    const resultPath = path.join(resultDir, `${fileId}.json`);
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf-8');
    fs.unlinkSync(filePath);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('❌ 에러:', error.message);
    res.status(500).json({
      error: error.message,
      hint: 'API Key와 환경설정을 확인하세요'
    });
  }
});

app.get('/api/results', (req, res) => {
  try {
    const resultDir = './results';
    if (!fs.existsSync(resultDir)) {
      return res.json({ results: [] });
    }

    const files = fs.readdirSync(resultDir);
    const results = files
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(resultDir, f), 'utf-8'));
        return {
          id: data.id,
          filename: data.filename,
          processedAt: data.processedAt
        };
      })
      .sort((a, b) => new Date(b.processedAt) - new Date(a.processedAt));

    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/results/:id', (req, res) => {
  try {
    const resultPath = path.join('./results', `${req.params.id}.json`);
    if (!fs.existsSync(resultPath)) {
      return res.status(404).json({ error: '결과를 찾을 수 없습니다' });
    }

    const data = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/export/:id', async (req, res) => {
  try {
    const resultPath = path.join('./results', `${req.params.id}.json`);
    if (!fs.existsSync(resultPath)) {
      return res.status(404).json({ error: '결과를 찾을 수 없습니다' });
    }

    const data = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    
    // insightJson 파싱
    let insightData;
    try {
      if (typeof data.insightJson === 'string') {
        insightData = JSON.parse(data.insightJson);
      } else {
        insightData = data.insightJson;
      }
    } catch (e) {
      console.error('JSON 파싱 실패:', e);
      insightData = { speaker_name: '(정보 없음)', speaker_title: '(정보 없음)', insights: [] };
    }

    // Word 문서 생성 (템플릿 기반)
    const docBuffer = await generateWordFromTemplate(insightData);

    res.setHeader('Content-Disposition', `attachment; filename="GasTech_Insight_${req.params.id}.docx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.send(docBuffer);

  } catch (error) {
    console.error('내보내기 에러:', error);
    res.status(500).json({ error: error.message });
  }
});

async function transcribeAudioWithGoogle(filePath) {
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  if (!GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY가 설정되지 않았습니다');
  }

  try {
    const audioBuffer = fs.readFileSync(filePath);
    const audioBase64 = audioBuffer.toString('base64');

    const response = await axios.post(
      `https://speech.googleapis.com/v1/speech:recognize?key=${GOOGLE_API_KEY}`,
      {
        config: {
          encoding: 'LINEAR16',
          languageCode: 'ko-KR',
          audioChannelCount: 1,
          enableAutomaticPunctuation: true
        },
        audio: {
          content: audioBase64
        }
      },
      {
        timeout: 600000
      }
    );

    if (response.data.results && response.data.results.length > 0) {
      return response.data.results
        .map(result => result.alternatives[0].transcript)
        .join(' ');
    } else {
      throw new Error('음성을 인식하지 못했습니다');
    }

  } catch (error) {
    console.error('Google STT 에러:', error.message);
    throw new Error(`음성 변환 실패: ${error.response?.data?.error?.message || error.message}`);
  }
}

async function organizeInsightWithGemini(transcript, metadata) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY가 설정되지 않았습니다');
  }

  const metadataObj = metadata || {};

  const systemPrompt = `당신은 글로벌 컨퍼런스 세션을 분석하여 구조화된 JSON 형식으로 핵심 인사이트를 추출하는 전문 비즈니스 애널리스트입니다.

[출력 형식 - 반드시 JSON만 출력]

반드시 다음의 JSON 구조로만 출력하세요:

{
  "speaker_name": "연사명",
  "speaker_title": "직책/소속",
  "date": "M/D일",
  "time": "시간 (예: 오전 8:40-9:00)",
  "insights": [
    {
      "main": "핵심 인사이트 (간결, 명사형 어미로 끝남)",
      "subs": ["부연설명 1", "부연설명 2"]
    },
    {
      "main": "다음 인사이트",
      "subs": ["부연설명"]
    }
  ]
}

[작성 규칙]

1. insights: 최대 3개 항목만 (내용을 1/3로 압축)
2. main: 명사 또는 명사형 어미로 끝남
3. subs: 최대 2개 (각 항목당)
4. 모든 텍스트: 마침표(.) 금지
5. 마크다운 서식 금지
6. 원문에 없는 정보 추가 금지
7. 극강의 간결성 (중요!)

[예시]

{
  "speaker_name": "Wael Sawan",
  "speaker_title": "Shell CEO",
  "date": "3/23일",
  "time": "오전 8:40-9:00",
  "insights": [
    {
      "main": "경제 번영과 국가 안보를 위한 포괄적이고 실용적인 에너지 정책 접근 필요",
      "subs": [
        "기존 에너지원과 청정 에너지원을 아우르는 방식 채택",
        "지난 10년간 미국의 천연가스 생산 증가, 재생에너지 용량 확장 동시 진행"
      ]
    },
    {
      "main": "청정에너지 전환 과정 중 안정적인 기저 전력원 확보의 중요성",
      "subs": [
        "독일은 재생에너지 과의존으로 전력망 불안정과 비용 상승 직면",
        "프랑스는 원자력 중심으로 유럽에서 가장 낮은 전기 요금 유지"
      ]
    }
  ]
}

JSON만 출력하세요.`;

  const userPrompt = `[연사 정보]
이름: ${metadataObj.speakerName || '(정보 없음)'}
직책/소속: ${metadataObj.speakerTitle || '(정보 없음)'}
날짜: ${metadataObj.date || '(정보 없음)'}
시간: ${metadataObj.time || '(정보 없음)'}

[원문 텍스트]
${transcript}

[작업 지시]
위의 JSON 구조를 정확하게 따르세요.
내용을 1/3로 압축하세요.
최대 3개의 Insight만 추출하세요.
각 Insight당 최대 2개의 부연설명만 포함하세요.`;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: systemPrompt + '\n\n' + userPrompt
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.7,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 2000
        }
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.candidates && response.data.candidates.length > 0) {
      const rawResponse = response.data.candidates[0].content.parts[0].text;
      
      // JSON 추출
      let jsonText = rawResponse;
      if (jsonText.includes('```json')) {
        jsonText = jsonText.split('```json')[1].split('```')[0];
      } else if (jsonText.includes('```')) {
        jsonText = jsonText.split('```')[1].split('```')[0];
      }
      
      const parsed = JSON.parse(jsonText.trim());
      return JSON.stringify(parsed);
    } else {
      throw new Error('Gemini 응답이 없습니다');
    }

  } catch (error) {
    console.error('Gemini API 에러:', error.message);
    throw new Error(`정리 실패: ${error.response?.data?.error?.message || error.message}`);
  }
}

/**
 * 템플릿 기반 Word 문서 생성
 * 템플릿 파일에서 placeholder를 JSON 데이터로 교체
 */
async function generateWordFromTemplate(insightData) {
  try {
    // 템플릿 파일 경로
    const templatePath = path.join(__dirname, 'template', 'compet_template.docx');
    
    // 기본 템플릿 경로 (없으면 샘플 템플릿 사용)
    let actualTemplatePath = templatePath;
    if (!fs.existsSync(actualTemplatePath)) {
      // 대체 경로 시도
      const altPath = path.join(__dirname, '컨퍼런스_MOM_Templete.docx');
      if (fs.existsSync(altPath)) {
        actualTemplatePath = altPath;
      } else {
        throw new Error('템플릿 파일을 찾을 수 없습니다');
      }
    }

    // 템플릿 파일 읽기
    const templateBuffer = fs.readFileSync(actualTemplatePath);
    const zip = new JSZip();
    await zip.loadAsync(templateBuffer);

    // document.xml 추출
    let documentXml = await zip.file('word/document.xml').async('string');

    // Placeholder 교체 함수
    const replaceInXml = (xml, placeholder, value) => {
      const regex = new RegExp(`\\[${placeholder}\\]`, 'g');
      return xml.replace(regex, value || '(정보 없음)');
    };

    // 데이터 추출
    const speakerName = insightData.speaker_name || '(정보 없음)';
    const speakerTitle = insightData.speaker_title || '(정보 없음)';
    const date = insightData.date || '(정보 없음)';
    const time = insightData.time || '(정보 없음)';
    const insights = insightData.insights || [];

    // 제목과 날짜 교체
    documentXml = replaceInXml(documentXml, '연사 이름', speakerName);
    documentXml = replaceInXml(documentXml, '회사명', '');
    documentXml = replaceInXml(documentXml, '직급', speakerTitle);
    documentXml = replaceInXml(documentXml, '세션 날짜', date);
    documentXml = replaceInXml(documentXml, '시간', time);

    // Insight 교체 (최대 3개)
    for (let i = 0; i < Math.min(insights.length, 3); i++) {
      const insight = insights[i];
      const insightNum = i + 1;

      // 메인 인사이트
      documentXml = replaceInXml(documentXml, `Insight ${insightNum}`, insight.main || '');

      // 부연설명
      if (insight.subs && Array.isArray(insight.subs)) {
        for (let j = 0; j < Math.min(insight.subs.length, 2); j++) {
          const subNum = j + 1;
          documentXml = replaceInXml(
            documentXml, 
            `Insight ${insightNum}에 대한 부연설명 ${subNum}`, 
            insight.subs[j] || ''
          );
        }
      }
    }

    // 사용하지 않은 placeholder 제거 (빈 문자열로)
    documentXml = documentXml.replace(/\[[^\]]+\]/g, '');

    // 수정된 document.xml을 ZIP에 저장
    zip.file('word/document.xml', documentXml);

    // Word 파일 생성
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return buffer;

  } catch (error) {
    console.error('Word 생성 에러:', error);
    throw error;
  }
}

app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'client', 'build', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: 'Not Found' });
  }
});

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║   GasTech Keynote Insight Organizer (Gemini Version)  ║
║                                                        ║
║   🌐 웹사이트: https://gastech-keynote.onrender.com   ║
║   🔌 로컬 테스트: http://localhost:${PORT}                  ║
║                                                        ║
║   필요한 환경변수 (.env):                              ║
║   - GOOGLE_API_KEY=...                                ║
║   - GEMINI_API_KEY=...                                ║
║                                                        ║
║   특징:                                                ║
║   - Word 템플릿 직접 사용                             ║
║   - Placeholder 자동 교체                            ║
║   - 100% 양식 보장                                    ║
║   - 내용 1/3로 압축 (3개 Insight)                     ║
║   - Gemini 2.5 Flash (최적화)                        ║
╚════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;