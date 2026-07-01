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

    const buffer = await generateWord(insightData);

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

async function organizeInsightWithGemini(transcript, metadata) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY가 설정되지 않았습니다');
  }

  const metadataObj = metadata || {};

  const systemPrompt = `당신은 글로벌 컨퍼런스 세션을 분석하여 구조화된 JSON 형식으로 핵심 인사이트를 추출하는 전문 비즈니스 애널리스트입니다.

[출력 형식 - 반드시 JSON만 출력]

{
  "speaker_name": "연사명",
  "speaker_title": "직책/소속",
  "date": "M/D일",
  "time": "시간",
  "insights": [
    {
      "main": "핵심 인사이트 (명사형 어미로 끝남)",
      "subs": ["부연설명 1", "부연설명 2"]
    }
  ]
}

[작성 규칙]
1. insights: 최대 3개
2. main: 명사형 어미로 끝남 (강조, 필요, 직면, 유지, 예정, 모색 등)
3. subs: 최대 2개
4. 마침표(.) 금지
5. 극강의 간결성

JSON만 출력하세요.`;

  const userPrompt = `[연사 정보]
이름: ${metadataObj.speakerName || '(정보 없음)'}
직책/소속: ${metadataObj.speakerTitle || '(정보 없음)'}
날짜: ${metadataObj.date || '(정보 없음)'}
시간: ${metadataObj.time || '(정보 없음)'}

[원문 텍스트]
${transcript}

위의 JSON 구조로 정리하세요.`;

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

async function generateWord(insightData) {
  try {
    const createRun = (text, isBold = false, size = 28) => {
      return new TextRun({
        text: text,
        font: '바탕체',
        size: size,
        bold: isBold,
        color: '000000'
      });
    };

    const paragraphs = [];

    // 제목
    if (insightData.speaker_name && insightData.speaker_title) {
      const titleText = `【${insightData.speaker_name} - ${insightData.speaker_title}】`;
      paragraphs.push(
        new Paragraph({
          text: titleText,
          spacing: {
            line: 240,
            after: 0
          },
          runs: [createRun(titleText, true)]
        })
      );
    }

    // 날짜
    if (insightData.date && insightData.time) {
      const dateText = `※ ${insightData.date}, ${insightData.time}`;
      paragraphs.push(
        new Paragraph({
          text: dateText,
          spacing: {
            line: 240,
            after: 240
          },
          runs: [createRun(dateText, false, 22)]
        })
      );
    }

    // Insights
    if (insightData.insights && Array.isArray(insightData.insights)) {
      insightData.insights.forEach((insight) => {
        // 메인 인사이트
        const mainText = `- ${insight.main}`;
        paragraphs.push(
          new Paragraph({
            text: mainText,
            spacing: {
              line: 240,
              after: 240
            },
            runs: [createRun(mainText, false)]
          })
        );

        // 부연 설명
        if (insight.subs && Array.isArray(insight.subs)) {
          insight.subs.forEach((sub) => {
            const subText = `  · ${sub}`;
            paragraphs.push(
              new Paragraph({
                text: subText,
                spacing: {
                  line: 240,
                  after: 240
                },
                runs: [createRun(subText, false)]
              })
            );
          });
        }
      });
    }

    // Word 문서 생성
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
║   - docx 라이브러리 직접 생성                        ║
║   - 템플릿 파일 불필요                               ║
║   - NASCA 보안 우회                                  ║
║   - 내용 1/3로 압축 (3개 Insight)                     ║
║   - Gemini 2.5 Flash 최적화                         ║
╚════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;