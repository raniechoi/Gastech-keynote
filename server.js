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
        children: generateDocxContent(data.insight)
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

  const systemPrompt = `당신은 글로벌 컨퍼런스 세션의 핵심 인사이트를 추출해, 최고 경영진(C-Level)이 단숨에 읽고 전체 흐름을 파악할 수 있도록 '초압축 인사이트 보고서'를 작성하는 전문 비즈니스 애널리스트입니다.

[출력 형식 - 절대 변경 금지]

반드시 아래의 정확한 형식으로만 출력하세요:

【[연사명] - [소속 및 직책]】
- [핵심 인사이트 1. 명사형 어미로 끝남]
- [핵심 인사이트 2. 명사형 어미로 끝남]
  (예시) [부연설명 텍스트]
- [핵심 인사이트 3. 명사형 어미로 끝남]

[작성 규칙 - 매우 중요]

1. 제목 형식:
   - 반드시 【[연사명] - [소속 및 직책]】 형식
   - 다른 문자나 기호 추가 금지

2. 핵심 인사이트 줄("-"):
   - 반드시 "- "로 시작 (하이픈 + 공백)
   - 모든 문장을 명사 또는 명사형 어미로 끝냄 (강조, 필요, 직면, 유지, 예정, 모색, 제시 등)
   - 마침표(.) 절대 금지
   - 서술형 어미(~습니다, ~입니다, ~합니다) 절대 금지
   - 마크다운 서식(**,#) 절대 금지

3. 부연설명 줄:
   - 인사이트 줄 다음에 필요시만 추가
   - 반드시 "  (예시) " 또는 "  " (띄어쓰기 2칸)로 시작
   - 마침표 금지, 마크다운 금지

4. 화폐 단위:
   - 외화: 천$, 백만$, 억$ 사용

5. 금지사항:
   - 원문에 없는 정보 추가 금지
   - 과장이나 추측 금지
   - 마크다운 서식 금지
   - 마침표 금지

[정확한 예시]

【Hon. Chris Wright - 미국 에너지부 장관】
- 경제 번영과 국가 안보 관점에서 기존 에너지원과 청정 에너지원을 아우르는 실용적 접근 강조
- 청정에너지 전환 기간 동안 천연가스, 원자력, 수력 같은 안정적인 기저 전력원 확보 필요
  (예시) 독일의 경우 재생에너지에 과도하게 의존하여 전력망 안정성과 비용 문제에 직면
- 미국 정부는 기존 에너지원에 대한 투자를 지속하면서 전력망 현대화와 신에너지 기술 투자 강화 예정

[최종 확인]
- 제목이 【】 형식인가
- 모든 "-" 줄이 명사형 어미로 끝나는가
- 마침표가 없는가
- 마크다운 서식이 없는가`;

  const userPrompt = `[연사 정보]
이름: ${metadataObj.speakerName || '(정보 없음)'}
소속/직책: ${metadataObj.speakerTitle || '(정보 없음)'}

[원문 텍스트]
${transcript}

[작업 지시]
위의 출력 형식과 작성 규칙을 절대적으로 준수하여 보고서를 작성하세요.
정확한 형식이 매우 중요합니다.`;

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
 * Word 문서 생성 (최적화된 파싱 + 완벽한 서식 적용)
 */
function generateDocxContent(insightText) {
  const { Paragraph, TextRun } = require('docx');

  const paragraphs = [];
  const lines = insightText.split('\n');

  // 기본 서식 설정
  const createTextRun = (text, isBold = false) => {
    return new TextRun({
      text: text,
      font: '바탕체',
      size: 28,  // 14pt
      bold: isBold,
      color: '000000'
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // 빈 줄 스킵
    if (!trimmedLine) {
      continue;
    }

    // 제목 감지: 【...】 형식
    if (trimmedLine.includes('【') && trimmedLine.includes('】')) {
      paragraphs.push(
        new Paragraph({
          text: trimmedLine,
          spacing: {
            line: 240,    // 1줄 간격
            after: 240    // 다음 줄 전에 12pt 간격
          },
          runs: [createTextRun(trimmedLine, true)]
        })
      );
    }

    // 핵심 인사이트 감지: "- "로 시작
    else if (trimmedLine.match(/^-\s+/)) {
      // "- " 제거하고 내용 추출
      const content = trimmedLine.replace(/^-\s+/, '');
      
      paragraphs.push(
        new Paragraph({
          text: '- ' + content,
          spacing: {
            line: 240,
            after: 240    // 12pt
          },
          runs: [createTextRun('- ' + content, false)]
        })
      );
    }

    // 부연설명 감지: 2칸 이상의 띄어쓰기로 시작
    else if (trimmedLine.match(/^\s{2,}/)) {
      paragraphs.push(
        new Paragraph({
          text: trimmedLine,
          spacing: {
            line: 240,
            after: 240    // 12pt
          },
          runs: [createTextRun(trimmedLine, false)]
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
          runs: [createTextRun(trimmedLine, false)]
        })
      );
    }
  }

  return paragraphs;
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
║   - 초압축 인사이트 보고서 (C-Level용)               ║
║   - 강화된 Gemini 프롬프트                            ║
║   - 최적화된 Word 파싱 & 서식                        ║
║   - 정규표현식 기반 형식 감지                         ║
║   - 완벽한 바탕체 14pt 서식 적용                     ║
╚════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;