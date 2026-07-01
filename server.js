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
    
    const { Document, Packer, Paragraph, TextRun, convertInchesToTwip } = require('docx');
    
    const doc = new Document({
      sections: [{
        properties: {
          margins: {
            top: convertInchesToTwip(2.5 / 2.54),      // 2.5cm
            bottom: convertInchesToTwip(2.5 / 2.54),   // 2.5cm
            left: convertInchesToTwip(2.0 / 2.54),     // 2.0cm
            right: convertInchesToTwip(2.0 / 2.54)     // 2.0cm
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
 * Gemini API로 정리 (인사이트 중심, 동작 단어 강제)
 */
async function organizeInsightWithGemini(transcript, metadata) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY가 설정되지 않았습니다');
  }

  const metadataObj = metadata || {};

  const systemPrompt = `당신은 컨퍼런스 키노트를 고급 보고서 형식으로 정리하는 전문가입니다.

[핵심 목표]
Keynote의 핵심 인사이트를 3~5개 추출하여, 각각을 완전하고 독립적인 내용으로 정리합니다.
"-"만 읽어도 전체 keynote의 핵심을 완벽하게 이해할 수 있어야 합니다.

[문서 구조]

1. 제목
   형식: 【[연사명], [직책/소속]】

2. 날짜 (제목 바로 아래)
   형식: ※ [월]/[일]일, [오전/오후] [시간]~[시간]

3. 핵심 인사이트 정리
   - 핵심 인사이트 1 (한두 줄, 동작 단어로 끝남)
     · 부연설명 1 (필요시만)
     · 부연설명 2 (필요시만)
   
   - 핵심 인사이트 2 (완전하고 독립적, 동작 단어로 끝남)
     · 관련 정보 또는 근거
   
   - 핵심 인사이트 3 (동작 단어로 끝남)

["-" 작성 규칙]
1. 최대 5개, 최소 3개 (3개가 이상적)
2. 각각은 완전하고 독립적인 내용
3. 마침표로 끝나는 온전한 문장
4. 핵심만 추출 (수사적 표현 제거)
5. 객관적이고 중립적 표현
6. "-"들만 읽었을 때 keynote 전체가 이해되어야 함

[★ 중요: 문장 종료 방식]
반드시 다음의 동작 단어로 끝나야 함 (상황에 맞게):
- 확대, 강화, 강조, 추진, 중시, 언급, 간주, 예상, 모색, 도모
- 전환, 전면 확대, 지속 추진, 전략적 방향, 강화 필요, 구축 추진
- 가능성 제시, 비중 확대, 접근 강조, 기반 조성

예시:
✅ "'Energy is life' 기조를 바탕으로 미국내 에너지 생산을 전면 확대"
✅ "청정에너지 전환 과정에서 경제 안정성을 함께 강조"
✅ "기존 에너지원과 신재생에너지의 균형 있는 발전 모색"

["·" 작성 규칙]
1. 필요할 때만 사용 (없어도 됨)
2. "-"와 같은 인사이트에 대한 부연설명
3. 구체적 근거, 통계, 사례, 추가 정보
4. 마침표로 끝나는 온전한 문장

[Word 문서 서식 지시]
- 글꼴: 바탕체 14pt
- 줄간격: 1줄
- 여백: 상/하 2.5cm, 좌/우 2.0cm
- 각주(※): 11pt

[단락 뒤 간격]
- 제목 ↓ 0pt
- 날짜 ↓ 16pt
- "-" ↓ 12pt
- "·" ↓ 12pt
- "·" 다음 "-" ↓ 16pt
- "-" 또는 "·"이 두 줄일 때 줄 사이 ↓ 0pt

[들여쓰기]
- "-" 앞: 공백 1칸
- "·" 앞: 공백 2칸

[화폐 단위]
- 외화 표기: 천$, 백만$, 억$

[작성 금지사항]
- "했습니다, 합니다" 등의 일상 어미 금지
- 동작 단어 없이 문장 종료 금지
- 원문에 없는 정보 추가 금지
- 과장이나 추측 금지
- 수사적 표현 금지
- 중복 제거`;

  const userPrompt = `[연사 정보]
연사명: ${metadataObj.speakerName || '(정보 없음)'}
직책/소속: ${metadataObj.speakerTitle || '(정보 없음)'}
발언일시: ${metadataObj.date || '(정보 없음)'}

[원문 텍스트]
${transcript}

[작업 지시]
위의 규칙과 서식을 정확히 따라 보고서를 작성하세요.

1. 제목과 날짜를 먼저 작성
2. Keynote에서 3~5개의 핵심 인사이트 추출
3. 각 인사이트를 "-"로 작성하되, 반드시 동작 단어로 끝낼 것
4. 필요시 "·"로 부연설명 추가
5. "-"만 읽어도 전체 keynote 이해 가능하도록 확인
6. 모든 "-"가 동작 단어로 끝나는지 최종 검증`;

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
 * Word 문서 생성 (바탕체 14pt, 1줄간격 완전 재작성)
 */
function generateDocxContent(data) {
  const { Paragraph, TextRun } = require('docx');

  const paragraphs = [];
  const lines = data.insight.split('\n').filter(line => line.trim() !== '');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

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
              bold: false
            })
          ]
        })
      );
    }
    
    // 날짜 (※로 시작)
    else if (trimmedLine.startsWith('※')) {
      paragraphs.push(
        new Paragraph({
          text: trimmedLine,
          spacing: {
            line: 240,
            after: 320  // 16pt
          },
          runs: [
            new TextRun({
              text: trimmedLine,
              font: '바탕체',
              size: 22,  // 11pt
              bold: false
            })
          ]
        })
      );
    }
    
    // "-" 항목
    else if (trimmedLine.startsWith('- ') || trimmedLine.startsWith('-')) {
      const content = trimmedLine.replace(/^-\s*/, '');
      
      // 다음 줄 확인 (·으로 시작하는지 확인)
      const nextLineIsDot = i + 1 < lines.length && 
                           (lines[i + 1].trim().startsWith('· ') || 
                            lines[i + 1].trim().startsWith('·'));
      
      paragraphs.push(
        new Paragraph({
          text: ' ' + content,
          spacing: {
            line: 240,
            after: 240  // 12pt
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
    
    // "·" 항목 (Middle Dot)
    else if (trimmedLine.startsWith('· ') || trimmedLine.startsWith('·')) {
      const content = trimmedLine.replace(/^·\s*/, '');
      
      // 다음 줄이 "-"로 시작하는지 확인
      const nextLineIsDash = i + 1 < lines.length && 
                            (lines[i + 1].trim().startsWith('- ') || 
                             lines[i + 1].trim().startsWith('-'));
      
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
    
    // 일반 텍스트
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
║   MaxTokens: 4000 (응답 길이 확대)                   ║
║   Word 서식: 바탕체 14pt, 1줄간격 (완전 재작성)     ║
║   특징: 동작 단어로 끝나는 인사이트 문장             ║
╚════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;