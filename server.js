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

app.post('/api/process-text', async (req, res) => {
  try {
    const { transcript, metadata } = req.body;

    if (!transcript || !transcript.trim()) {
      return res.status(400).json({ error: '텍스트를 입력해주세요' });
    }

    const fileId = uuidv4();
    console.log(`📝 텍스트 수신: ${transcript.length}자`);

    console.log('🤖 Gemini API로 정리 중...');
    const insight = await organizeInsightWithGemini(transcript, metadata);
    console.log('✓ 정리 완료');

    const result = {
      id: fileId,
      filename: metadata?.source || 'Plaud Note Pro',
      metadata: metadata || {},
      transcript: transcript,
      insight: insight,
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
    const insight = await organizeInsightWithGemini(transcript, metadata);
    console.log('✓ 정리 완료');

    const result = {
      id: fileId,
      filename: req.file.originalname,
      metadata: metadata ? JSON.parse(metadata) : {},
      transcript: transcript,
      insight: insight,
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

app.post('/api/export/:id', (req, res) => {
  try {
    const resultPath = path.join('./results', `${req.params.id}.json`);
    if (!fs.existsSync(resultPath)) {
      return res.status(404).json({ error: '결과를 찾을 수 없습니다' });
    }

    const data = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    
    const { Document, Packer, Paragraph, TextRun, convertInchesToTwip } = require('docx');
    
    const doc = new Document({
      sections: [{
        properties: {
          margins: {
            top: convertInchesToTwip(2.5 / 2.54),
            bottom: convertInchesToTwip(2.5 / 2.54),
            left: convertInchesToTwip(2.0 / 2.54),
            right: convertInchesToTwip(2.0 / 2.54)
          }
        },
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

async function transcribeAudioWithGoogle(filePath) {
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  if (!GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY가 설정되지 않았습니다');
  }

  try {
    const audioBuffer = fs.readFileSync(filePath);
    const audioBase64 = audioBuffer.toString('base64');

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

  const systemPrompt = `당신은 글로벌 컨퍼런스와 비즈니스 세션의 핵심 인사이트를 추출해 전문적인 경영 보고서(Executive Summary) 형태로 요약하는 '전문 비즈니스 애널리스트'입니다.

[작성 규칙 - 반드시 엄수]

1. 문체 및 내용 구성:
   - 메인 인사이트("-"): 세션의 핵심 주장이나 인사이트를 요약합니다.
   - 부연 설명("·"): "-"에 대한 구체적 근거, 통계, 사례, 추가 정보를 기재합니다.
   - 문장 종결: 모든 문장은 마침표(.)로 끝나는 온전한 문장으로 작성합니다.
   - 설명 위주: 불필요한 동작 단어는 제외합니다.

2. 구조 및 들여쓰기:
   - 제목: 【[연사명] - [소속 및 직책]】
   - 날짜: * [월]/[일]일, [오전/오후] [시간]-[시간]
   - 메인 인사이트 앞: 공백 1칸 후 하이픈 (예: " - 핵심 내용입니다.")
   - 부연 설명 앞: 공백 2칸 후 가운뎃점 (예: "  · 구체적 근거입니다.")

3. 화폐 단위:
   - 외화 표기: 천$, 백만$, 억$ 단위 사용 (예: $150 billion -> 1,500억$)

4. 금지사항:
   - 원문에 없는 정보 추가 금지
   - 과장이나 추측 금지

[출력 형식 예시]

【Hon. Chris Wright - 미국 에너지부 장관】
* 3/23일, 오전 8:40-9:00

 - 'Energy is life' 기조를 바탕으로 미국 내 에너지 생산을 전면 확대합니다.
  · 지난 13개월 동안 18 Bcf/d 규모의 신규 LNG 수출을 승인하며 미국이 세계 최대의 천연가스 수출국이 되었습니다.
  · 천연가스를 AI 산업 부흥 및 제조업 리쇼어링을 위한 핵심 요소로 간주하고 있습니다.

 - 최근 중동 분쟁으로 인한 우려 및 대응을 위해 전략비축유 방출을 결정했습니다.
  · 규제 완화를 통해 미국의 에너지 안보와 경제적 우위를 동시에 확보할 계획입니다.

위의 규칙과 형식을 정확히 따르세요.`;

  const userPrompt = `[연사 정보]
이름: ${metadataObj.speakerName || '(정보 없음)'}
소속/직책: ${metadataObj.speakerTitle || '(정보 없음)'}
날짜/시간: ${metadataObj.date || '(정보 없음)'}

[원문 텍스트]
${transcript}

[작업 지시]
위의 작성 규칙과 형식을 엄격하게 준수하여 요약 리포트를 작성하세요.

1. 제목: 【[연사명] - [소속/직책]】
2. 날짜: * [월/일]일, [오전/오후] [시간]-[시간]
3. 메인 인사이트("-") 3~5개 추출
4. 각 "-"에 필요시 "·"으로 부연 설명 추가
5. 모든 문장을 마침표(.)로 종료
6. 화폐 단위를 천$, 백만$, 억$ 단위로 변환`;

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
          maxOutputTokens: 4000
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
 * Word 문서 생성 (강화된 버전)
 * 모든 텍스트에 폰트, 크기, 줄간격, 단락 간격 명시
 */
function generateDocxContent(data) {
  const { Paragraph, TextRun } = require('docx');

  const paragraphs = [];
  const lines = data.insight.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // 빈 줄 스킵
    if (!trimmedLine) continue;

    // 제목 (【...】 형식)
    if (trimmedLine.startsWith('【') && trimmedLine.endsWith('】')) {
      paragraphs.push(
        new Paragraph({
          text: trimmedLine,
          spacing: {
            line: 240,  // 1줄 간격
            after: 0    // 제목 뒤 0pt
          },
          runs: [
            new TextRun({
              text: trimmedLine,
              font: '바탕체',
              size: 28,  // 14pt
              bold: true
            })
          ]
        })
      );
    }
    
    // 날짜 (*로 시작)
    else if (trimmedLine.startsWith('*')) {
      paragraphs.push(
        new Paragraph({
          text: trimmedLine,
          spacing: {
            line: 240,
            after: 320  // 16pt (빈 줄 1개)
          },
          runs: [
            new TextRun({
              text: trimmedLine,
              font: '바탕체',
              size: 28,  // 14pt
              bold: false
            })
          ]
        })
      );
    }
    
    // "-" 항목 (메인 인사이트)
    else if (trimmedLine.startsWith('- ') || (trimmedLine.startsWith('-') && trimmedLine.length > 1)) {
      const content = trimmedLine.replace(/^-\s*/, '');
      
      // 다음 줄 확인 (·으로 시작하는지, 또는 다음 "-"인지)
      let nextLineIsDot = false;
      let nextLineIsDash = false;
      
      if (i + 1 < lines.length) {
        const nextTrimmed = lines[i + 1].trim();
        nextLineIsDot = nextTrimmed.startsWith('· ') || nextTrimmed.startsWith('·');
        nextLineIsDash = nextTrimmed.startsWith('- ') || (nextTrimmed.startsWith('-') && nextTrimmed.length > 1);
      }
      
      paragraphs.push(
        new Paragraph({
          text: ' ' + content,
          spacing: {
            line: 240,
            after: 240  // 12pt (빈 줄)
          },
          runs: [
            new TextRun({
              text: ' ' + content,
              font: '바탕체',
              size: 28,  // 14pt
              bold: false
            })
          ]
        })
      );
    }
    
    // "·" 항목 (부연 설명)
    else if (trimmedLine.startsWith('· ') || (trimmedLine.startsWith('·') && trimmedLine.length > 1)) {
      const content = trimmedLine.replace(/^·\s*/, '');
      
      // 다음 줄이 "-"로 시작하는지 확인
      let nextLineIsDash = false;
      if (i + 1 < lines.length) {
        const nextTrimmed = lines[i + 1].trim();
        nextLineIsDash = nextTrimmed.startsWith('- ') || (nextTrimmed.startsWith('-') && nextTrimmed.length > 1);
      }
      
      paragraphs.push(
        new Paragraph({
          text: '  ' + content,
          spacing: {
            line: 240,
            after: nextLineIsDash ? 320 : 240  // 다음이 "-"면 16pt, 아니면 12pt
          },
          runs: [
            new TextRun({
              text: '  ' + content,
              font: '바탕체',
              size: 28,  // 14pt
              bold: false
            })
          ]
        })
      );
    }
    
    // 기타 텍스트
    else {
      paragraphs.push(
        new Paragraph({
          text: trimmedLine,
          spacing: {
            line: 240,
            after: 240
          },
          runs: [
            new TextRun({
              text: trimmedLine,
              font: '바탕체',
              size: 28,  // 14pt
              bold: false
            })
          ]
        })
      );
    }
  }

  return paragraphs;
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
║   Gemini 모델: gemini-2.5-flash                       ║
║   MaxTokens: 4000                                     ║
║   Word 서식: 바탕체 14pt, 1줄간격 (완전 강화)       ║
║   특징: Executive Summary 형식                       ║
╚════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;