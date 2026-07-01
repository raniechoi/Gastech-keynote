const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { Document, Packer, Paragraph, TextRun, convertInchesToTwip } = require('docx');
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

// ===== API ENDPOINTS =====

app.post('/api/process-text', async (req, res) => {
  try {
    const { transcript, metadata } = req.body;
    if (!transcript || !transcript.trim()) {
      return res.status(400).json({ error: '텍스트를 입력해주세요' });
    }

    const fileId = uuidv4();
    console.log(`📝 텍스트 수신: ${transcript.length}자`);
    console.log('🤖 단계 1: 줄글 요약 생성 중...');
    const webSummary = await generateWebSummary(transcript, metadata);
    console.log('✓ 웹용 요약 완료');

    console.log('🤖 단계 2: Word 양식 요약 생성 중...');
    const wordSummary = await generateWordSummary(webSummary, metadata);
    console.log('✓ Word용 요약 완료');

    const result = {
      id: fileId,
      filename: metadata?.source || 'Plaud Note Pro',
      metadata: metadata || {},
      transcript: transcript,
      webSummary: webSummary,
      wordSummary: wordSummary,
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

    console.log('🤖 단계 1: 줄글 요약 생성 중...');
    const webSummary = await generateWebSummary(transcript, metadata);
    console.log('✓ 웹용 요약 완료');

    console.log('🤖 단계 2: Word 양식 요약 생성 중...');
    const wordSummary = await generateWordSummary(webSummary, metadata);
    console.log('✓ Word용 요약 완료');

    const result = {
      id: fileId,
      filename: req.file.originalname,
      metadata: metadata ? JSON.parse(metadata) : {},
      transcript: transcript,
      webSummary: webSummary,
      wordSummary: wordSummary,
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
    const wordSummaryText = data.wordSummary || '';

    const buffer = await generateWordDocument(wordSummaryText);

    res.setHeader('Content-Disposition', `attachment; filename="GasTech_Insight_${req.params.id}.docx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.send(buffer);

  } catch (error) {
    console.error('내보내기 에러:', error);
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

async function generateWebSummary(transcript, metadata) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY가 설정되지 않았습니다');
  }

  const systemPrompt = `당신은 글로벌 컨퍼런스 키노트의 긴 스크립트(STT 변환 텍스트)를 읽고, 핵심 내용을 1/3 수준의 간결한 줄글 요약으로 정리하는 전문 비즈니스 애널리스트입니다.

[작업 지시]
- 입력: 긴 스크립트 텍스트
- 출력: 형식 없는 일반 줄글 (마크다운 금지)
- 분량: 원문의 약 1/3 정도로 압축
- 스타일: 자연스러운 문단 형태, 마침표(.)와 공식적 문체 사용 가능

핵심 내용, 주요 주장, 구체적 사례를 포함하되, 단순 키워드가 아닌 완전한 문맥으로 작성하십시오.
마크다운(**, #, 등)을 절대 사용하지 마십시오.`;

  const userPrompt = `다음 스크립트를 1/3 수준의 줄글 요약으로 정리해주세요:

${transcript}`;

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
      const summary = response.data.candidates[0].content.parts[0].text;
      return summary.trim();
    } else {
      throw new Error('Gemini 응답이 없습니다');
    }

  } catch (error) {
    console.error('Web 요약 생성 에러:', error.message);
    throw new Error(`요약 생성 실패: ${error.message}`);
  }
}

async function generateWordSummary(webSummary, metadata) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY가 설정되지 않았습니다');
  }

  const metadataObj = metadata || {};

  const systemPrompt = `당신은 글로벌 컨퍼런스 키노트 세션의 스크립트(STT 녹음 변환 텍스트)를 분석하여, 최고 경영진(C-Level)이 단숨에 핵심을 파악할 수 있도록 '초압축 인사이트 보고서'를 작성하는 전문 비즈니스 애널리스트입니다.

사용자가 키노트 요약을 입력하면, 아래의 [작성 규칙 및 템플릿 서식]을 엄격하게 적용하여 단일 세션에 대한 보고서를 출력해 주세요.

[작성 규칙 및 템플릿 서식] - 매우 중요 (시스템은 이 규칙을 절대 이탈해서는 안 됨)

1. 서식 및 들여쓰기 (마크다운 기호 렌더링 절대 금지):
   - AI 특유의 굵은 글씨(**), 헤딩(#) 등 마크다운 기호를 절대 사용하지 마십시오. 오직 순수 텍스트와 아래 지정된 특수기호, 띄어쓰기만 사용하십시오.
   - 제목: 띄어쓰기 없이 【[연사 이름] - [회사명] [직급]】 형태로 첫 줄에 작성하십시오. (정보가 부족하면 요약에서 추론하여 채울 것)
   - 날짜 및 시간: 제목 다음 줄 맨 앞에 공백 2칸 후 ※ [세션 날짜], [시간] 작성. (요약에 명시되지 않은 경우 생략 가능)
   - 메인 인사이트: 맨 앞에 공백 1칸 후 - 기호 사용.
   - 부연 설명: 맨 앞에 공백 2칸 후 · 기호 사용.

2. 내용의 깊이 및 길이 (A4 1줄 분량 확보):
   - 각 항목(- 및 ·)은 단순 키워드 나열(예: "에너지 정책 필요성")이 되어서는 안 됩니다.
   - 배경, 원인, 구체적 실행 방안이나 결과가 모두 포함된 완전한 문맥(Complete thought)으로 구성하여, 문서 A4 기준 한 줄을 꽉 채울 수 있는 분량(약 50~80자 내외)으로 풍부하게 작성하십시오.

3. 문체 (개조식 및 명사형 종결):
   - 서술형 문장(~습니다, ~입니다, ~합니다)은 절대 사용하지 마십시오.
   - 모든 항목의 맨 끝은 반드시 명사형 어미(예: ~강조, ~필요, ~유지, ~예정, ~모색, ~기여, ~주문 등)로 마무리하십시오.
   - 문장 끝에 마침표(.)는 절대 찍지 마십시오.

[출력 양식 예시]
【Wael Sawan - Shell CEO】
  ※ 3/24일, 오전 9:00-9:20
 - 경제 번영과 국가 안보 관점에서 단일 에너지원에 의존하는 제로섬 게임을 탈피하고, 기존 에너지원과 청정 에너지를 모두 아우르는 실용적 접근 방식 강조
  · 기후 변화 대응을 위한 에너지 전환 과정에서도 천연가스, 원자력 등 신뢰할 수 있는 기저 전력원이 지속적으로 뒷받침되어야 함을 역설
  · 과거 독일이 재생에너지에 과도하게 의존하여 전력망 안정성과 비용 문제에 직면했던 반면, 프랑스는 원자력을 통해 낮은 전기요금을 유지
 - 정부 정책과 합리적인 인허가 절차를 통해 에너지 혁신이 번창할 수 있는 여건을 조성하고 자유 시장의 효율적 기능을 극대화할 것을 주문
  · 합리적인 허가, 그리드 현대화, R&D 투자를 통해 에너지 전환 속도를 맞추면서도 안정적인 물리적 공급 복원력(Resilience) 확보 모색

위 양식을 완벽하게 모방하여 출력하십시오.`;

  const userPrompt = `[연사 정보]
이름: ${metadataObj.speakerName || '(요약에서 추론)'}
회사/직급: ${metadataObj.speakerTitle || '(요약에서 추론)'}
날짜: ${metadataObj.date || '(생략 가능)'}
시간: ${metadataObj.time || '(생략 가능)'}

[요약 텍스트]
${webSummary}

[작업 지시]
위 요약을 바탕으로 위의 [작성 규칙 및 템플릿 서식]을 엄격하게 적용하여 경영진용 보고서를 작성하십시오.
핵심 인사이트만 2~3개의 메인 항목(-)과 각 항목당 2개의 부연 설명(·)으로 정리하십시오.`;

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
      const summary = response.data.candidates[0].content.parts[0].text;
      return summary.trim();
    } else {
      throw new Error('Gemini 응답이 없습니다');
    }

  } catch (error) {
    console.error('Word 요약 생성 에러:', error.message);
    throw new Error(`Word 요약 생성 실패: ${error.message}`);
  }
}

async function generateWordDocument(wordSummaryText) {
  try {
    const paragraphs = [];
    const lines = wordSummaryText.split('\n');

    const createRun = (text, isBold = false, size = 28) => {
      return new TextRun({
        text: text,
        font: '바탕체',
        size: size,
        bold: isBold,
        color: '000000'
      });
    };

    for (const line of lines) {
      if (!line.trim()) continue;

      paragraphs.push(
        new Paragraph({
          text: line,
          spacing: {
            line: 240,
            after: 240
          },
          runs: [createRun(line, false)]
        })
      );
    }

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
        children: paragraphs
      }]
    });

    const buffer = await Packer.toBuffer(doc);
    return buffer;

  } catch (error) {
    console.error('Word 생성 에러:', error);
    throw error;
  }
}

// ===== STATIC FILES & SPA =====

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
║   특징:                                                ║
║   - 웹: STT 텍스트 → 1/3 줄글 요약                   ║
║   - Word: 줄글 → 경영진용 양식 (A4 한 줄)           ║
║   - 2단계 Gemini 처리                                ║
║   - docx 라이브러리 직접 생성                        ║
╚════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;