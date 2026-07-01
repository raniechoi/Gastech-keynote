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

app.post('/api/export/:id', (req, res) => {
  try {
    const resultPath = path.join('./results', `${req.params.id}.json`);
    if (!fs.existsSync(resultPath)) {
      return res.status(404).json({ error: '결과를 찾을 수 없습니다' });
    }

    const data = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    
    const { Document, Packer, Paragraph, TextRun, convertInchesToTwip } = require('docx');
    
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
        children: generateDocxContent(insightData)
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

  const systemPrompt = `당신은 글로벌 컨퍼런스 세션을 분석하여 구조화된 JSON 형식으로 핵심 인사이트를 추출하는 전문 비즈니스 애널리스트입니다.

[출력 형식 - 반드시 JSON만 출력]

반드시 다음의 JSON 구조로만 출력하세요. 다른 텍스트는 절대 포함하지 마세요.

{
  "speaker_name": "연사명",
  "speaker_title": "직책/소속",
  "date": "M/D일",
  "time_start": "오전 또는 오후",
  "time_end": "시간 (예: 8:40-9:00)",
  "insights": [
    {
      "main": "핵심 인사이트 (명사형 어미로 끝남)",
      "subs": [
        "부연설명 1",
        "부연설명 2"
      ]
    },
    {
      "main": "다음 인사이트 (명사형 어미로 끝남)",
      "subs": [
        "부연설명"
      ]
    }
  ]
}

[작성 규칙]

1. insights 배열: 3~5개의 항목 (각각 main + subs 구조)
2. main: 명사 또는 명사형 어미로 끝남 (강조, 필요, 직면, 유지, 예정, 모색 등)
3. subs: 부연설명 배열 (필요시만, 없으면 빈 배열 [])
4. 모든 텍스트: 마침표(.) 금지
5. 마크다운 서식 금지
6. JSON 형식 철저히 준수
7. 원문에 없는 정보 추가 금지

[예시]

{
  "speaker_name": "Wael Sawan",
  "speaker_title": "Shell CEO",
  "date": "3/23일",
  "time_start": "오전",
  "time_end": "8:40-9:00",
  "insights": [
    {
      "main": "경제 번영과 국가 안보 관점에서 기존 에너지원과 청정 에너지원을 아우르는 실용적 접근 강조",
      "subs": [
        "지난 13개월 동안 18 Bcf/d 규모의 신규 LNG 수출 승인",
        "미국이 세계 최대의 천연가스 수출국으로 성장"
      ]
    },
    {
      "main": "청정에너지 전환 기간 동안 안정적인 기저 전력원 확보 필요",
      "subs": [
        "독글: 재생에너지 과의존으로 전력망 불안정과 비용 문제 직면",
        "프랑스: 원자력 중심으로 유럽에서 가장 낮은 전기요금 유지"
      ]
    }
  ]
}

JSON만 출력하세요. 다른 텍스트는 절대 포함하지 마세요.`;

  const userPrompt = `[연사 정보]
이름: ${metadataObj.speakerName || '(정보 없음)'}
소속/직책: ${metadataObj.speakerTitle || '(정보 없음)'}
날짜: ${metadataObj.date || '(정보 없음)'}
시간: ${metadataObj.time || '(정보 없음)'}

[원문 텍스트]
${transcript}

[작업 지시]
위의 JSON 구조를 정확하게 따르세요.
JSON만 출력하세요.
다른 텍스트는 절대 포함하지 마세요.`;

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
      const rawResponse = response.data.candidates[0].content.parts[0].text;
      
      // JSON 추출 (마크다운 코드블록 제거)
      let jsonText = rawResponse;
      if (jsonText.includes('```json')) {
        jsonText = jsonText.split('```json')[1].split('```')[0];
      } else if (jsonText.includes('```')) {
        jsonText = jsonText.split('```')[1].split('```')[0];
      }
      
      // JSON 파싱 검증
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
 * Word 문서 생성 (JSON 데이터 기반 템플릿)
 */
function generateDocxContent(insightData) {
  const { Paragraph, TextRun } = require('docx');

  const paragraphs = [];

  // 헬퍼 함수: TextRun 생성
  const createRun = (text, isBold = false) => {
    return new TextRun({
      text: text,
      font: '바탕체',
      size: 28,  // 14pt
      bold: isBold,
      color: '000000'
    });
  };

  // 1. 제목
  const titleText = `【${insightData.speaker_name} - ${insightData.speaker_title}】`;
  paragraphs.push(
    new Paragraph({
      text: titleText,
      spacing: {
        line: 240,    // 1줄
        after: 0      // 제목 뒤 0pt
      },
      runs: [createRun(titleText, true)]
    })
  );

  // 2. 날짜
  const dateText = `* ${insightData.date}, ${insightData.time_start} ${insightData.time_end}`;
  paragraphs.push(
    new Paragraph({
      text: dateText,
      spacing: {
        line: 240,
        after: 240    // 12pt (빈 줄 1개로 표현)
      },
      runs: [createRun(dateText, false)]
    })
  );

  // 3. 인사이트 항목들
  if (insightData.insights && Array.isArray(insightData.insights)) {
    insightData.insights.forEach((insight, index) => {
      // 메인 인사이트 ("-")
      const mainText = `- ${insight.main}`;
      paragraphs.push(
        new Paragraph({
          text: mainText,
          spacing: {
            line: 240,
            after: 240    // 12pt
          },
          runs: [createRun(mainText, false)]
        })
      );

      // 부연 설명 ("·")
      if (insight.subs && Array.isArray(insight.subs) && insight.subs.length > 0) {
        insight.subs.forEach((sub, subIndex) => {
          const isLastSub = subIndex === insight.subs.length - 1;
          const isLastInsight = index === insightData.insights.length - 1;
          
          const subText = `  · ${sub}`;
          paragraphs.push(
            new Paragraph({
              text: subText,
              spacing: {
                line: 240,
                after: (isLastSub && !isLastInsight) ? 240 : 240  // 12pt
              },
              runs: [createRun(subText, false)]
            })
          );
        });
      }
    });
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
║   - Word 템플릿 + JSON 데이터 방식                    ║
║   - 100% 양식 보장                                    ║
║   - 정확한 파싱 (정규표현식 불필요)                  ║
║   - 안정적이고 깔끔한 구조                            ║
║   - Gemini 2.5 Flash JSON 출력                       ║
╚════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;