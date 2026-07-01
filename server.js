const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// ===== CORS & Middleware =====
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ===== 정적 파일 제공 (React 빌드) =====
const clientBuildPath = path.join(__dirname, 'client', 'build');
if (fs.existsSync(clientBuildPath)) {
  app.use(express.static(clientBuildPath));
} else {
  // 개발 환경: public 폴더 사용
  const publicPath = path.join(__dirname, 'public');
  if (fs.existsSync(publicPath)) {
    app.use(express.static(publicPath));
  }
}

// ===== 파일 업로드 설정 =====
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

// ===== API ROUTES =====

/**
 * POST /api/process-text
 * 텍스트 → Gemini 정리 (새로운 엔드포인트)
 */
app.post('/api/process-text', async (req, res) => {
  try {
    const { transcript, metadata } = req.body;

    if (!transcript || !transcript.trim()) {
      return res.status(400).json({ error: '텍스트를 입력해주세요' });
    }

    const fileId = uuidv4();

    console.log(`📝 텍스트 수신: ${transcript.length}자`);

    // ===== STEP 1: Gemini API로 정리 =====
    console.log('🤖 Gemini API로 정리 중...');
    const insight = await organizeInsightWithGemini(transcript, metadata);
    console.log('✓ 정리 완료');

    // ===== STEP 2: 결과 저장 =====
    const result = {
      id: fileId,
      filename: metadata?.source || 'Plaud Note Pro',
      metadata: metadata || {},
      transcript: transcript,
      insight: insight,
      processedAt: new Date().toISOString()
    };

    // 결과 저장
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

/**
 * POST /api/process-keynote
 * 오디오 파일 → STT → Gemini 정리 (기존 엔드포인트)
 */
app.post('/api/process-keynote', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '오디오 파일을 선택해주세요' });
    }

    const { metadata } = req.body;
    const filePath = req.file.path;
    const fileId = uuidv4();

    console.log(`📁 파일 수신: ${req.file.originalname}`);

    // ===== STEP 1: Google Speech-to-Text =====
    console.log('🎤 Google Speech-to-Text 변환 중...');
    const transcript = await transcribeAudioWithGoogle(filePath);
    console.log('✓ STT 완료');

    // ===== STEP 2: Gemini API로 정리 =====
    console.log('🤖 Gemini API로 정리 중...');
    const insight = await organizeInsightWithGemini(transcript, metadata);
    console.log('✓ 정리 완료');

    // ===== STEP 3: 결과 저장 =====
    const result = {
      id: fileId,
      filename: req.file.originalname,
      metadata: metadata ? JSON.parse(metadata) : {},
      transcript: transcript,
      insight: insight,
      processedAt: new Date().toISOString()
    };

    // 결과 저장
    const resultDir = './results';
    if (!fs.existsSync(resultDir)) {
      fs.mkdirSync(resultDir);
    }
    const resultPath = path.join(resultDir, `${fileId}.json`);
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf-8');

    // 임시 파일 삭제
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

/**
 * GET /api/results
 * 저장된 결과 목록
 */
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

/**
 * GET /api/results/:id
 * 특정 결과 조회
 */
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

/**
 * POST /api/export/:id
 * Word 문서로 내보내기
 */
app.post('/api/export/:id', (req, res) => {
  try {
    const resultPath = path.join('./results', `${req.params.id}.json`);
    if (!fs.existsSync(resultPath)) {
      return res.status(404).json({ error: '결과를 찾을 수 없습니다' });
    }

    const data = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    
    const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx');
    
    const doc = new Document({
      sections: [{
        children: generateDocxContent(data)
      }]
    });

    Packer.toBuffer(doc).then(buffer => {
      res.setHeader('Content-Disposition', `attachment; filename="GasTech_Insight_${req.params.id}.docx"`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.send(buffer);
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== HELPER FUNCTIONS =====

/**
 * Google Cloud Speech-to-Text 사용
 */
async function transcribeAudioWithGoogle(filePath) {
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  if (!GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY가 설정되지 않았습니다');
  }

  try {
    // 파일을 base64로 인코딩
    const audioBuffer = fs.readFileSync(filePath);
    const audioBase64 = audioBuffer.toString('base64');

    // MIME 타입 감지
    let audioMimeType = 'audio/mpeg';
    if (filePath.endsWith('.wav')) {
      audioMimeType = 'audio/wav';
    } else if (filePath.endsWith('.mp4')) {
      audioMimeType = 'audio/mp4';
    } else if (filePath.endsWith('.webm')) {
      audioMimeType = 'audio/webm';
    }

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
        timeout: 600000 // 10분
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

/**
 * Gemini API로 정리 (CERAWeek 보고서 양식 적용)
 */
async function organizeInsightWithGemini(transcript, metadata) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY가 설정되지 않았습니다');
  }

  const metadataObj = metadata || {};

  const systemPrompt = `당신은 CERAWeek 보고서를 작성하는 전문 기자입니다.

[중요한 포맷 지침]
다음의 "네모박스 - 땡" 구조로 정확히 정리하세요:

■ 섹션 제목 (각 섹션은 독립적으로 읽을 수 있어야 함)
    • 핵심 내용 1
    • 핵심 내용 2
    • 핵심 내용 3

[구성 요소]

■ 연사 정보 및 배경
    • 연사명: [이름]
    • 직책: [직책/직위]
    • 발언일시: [날짜/시간]
    • 핵심 배경: [연사의 입장/역할]

■ 핵심 주장
    • [가장 중요한 메시지 1]
    • [가장 중요한 메시지 2]
    • [가장 중요한 메시지 3]

■ 근거 및 데이터
    • [구체적 통계 또는 사례 1]
    • [구체적 통계 또는 사례 2]
    • [구체적 통계 또는 사례 3]

■ 정책 제안 또는 액션 아이템
    • [제안사항 또는 액션 1]
    • [제안사항 또는 액션 2]
    • [제안사항 또는 액션 3]

■ 산업에 미치는 영향
    • [영향 1]
    • [영향 2]
    • [영향 3]

[작성 규칙]
- 각 "네모박스"의 제목만 읽어도 전체 맥락을 이해할 수 있도록 작성
- 각 "땡(bullet point)"은 완전한 문장으로, 추가 설명 없이도 독립적으로 이해 가능하도록
- 한글로 작성
- 객관적이고 중립적 표현
- 원문의 핵심만 추출, 중복 제거
- 수사적 표현이나 추측 배제`;

  const userPrompt = `다음은 컨퍼런스 키노트의 텍스트입니다:

[메타데이터]
연사명: ${metadataObj.speakerName || '(미입력)'}
직책: ${metadataObj.speakerTitle || '(미입력)'}
날짜: ${metadataObj.date || '(미입력)'}
출처: ${metadataObj.source || 'Plaud Note Pro'}

[원문 텍스트]
${transcript}

위의 포맷 지침과 구성 요소를 정확히 따라 정리해주세요.`;

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
          maxOutputTokens: 2048
        }
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.candidates && response.data.candidates.length > 0) {
      return response.data.candidates[0].content.parts[0].text;
    } else {
      throw new Error('Gemini 응답이 없습니다');
    }

  } catch (error) {
    console.error('Gemini API 에러:', error.message);
    throw new Error(`정리 실패: ${error.response?.data?.error?.message || error.message}`);
  }
}

/**
 * Word 문서 생성
 */
function generateDocxContent(data) {
  const { Paragraph, TextRun, AlignmentType } = require('docx');

  return [
    new Paragraph({
      text: 'GasTech 2026 - Keynote Insight',
      heading: 'Heading1',
      themeColor: 'accent1',
      size: 28,
      bold: true,
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 }
    }),
    new Paragraph({
      text: `원본 파일: ${data.filename}`,
      spacing: { after: 100 },
      size: 20
    }),
    new Paragraph({
      text: `처리 일시: ${new Date(data.processedAt).toLocaleString('ko-KR')}`,
      spacing: { after: 400 },
      size: 20
    }),
    new Paragraph({
      text: '【 정리 내용 】',
      heading: 'Heading2',
      size: 24,
      bold: true,
      spacing: { before: 200, after: 200 }
    }),
    new Paragraph({
      text: data.insight,
      spacing: { line: 360 },
      size: 22
    }),
    new Paragraph({
      text: '',
      spacing: { after: 200 }
    }),
    new Paragraph({
      text: '- 以 上 -',
      alignment: AlignmentType.CENTER,
      size: 22,
      spacing: { before: 400 }
    })
  ];
}

// ===== React SPA Fallback =====
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'client', 'build', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: 'Not Found' });
  }
});

// ===== SERVER START =====
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
║   API 엔드포인트:                                      ║
║   - POST /api/process-text (텍스트 입력)             ║
║   - POST /api/process-keynote (오디오 파일)          ║
║                                                        ║
║   Gemini 모델: gemini-2.5-flash (최신 모델)          ║
║   보고서 양식: CERAWeek 보고서 (네모박스-땡 구조)    ║
╚════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;