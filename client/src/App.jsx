import React, { useState, useRef, useEffect } from 'react';
import './App.css';

function App() {
  const [transcriptText, setTranscriptText] = useState('');
  const [metadata, setMetadata] = useState({ 
    speakerName: '', 
    speakerTitle: '', 
    date: '',
    source: 'Plaud Note Pro'
  });
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);
  const [apiBaseUrl, setApiBaseUrl] = useState('');

  // API 기본 URL 설정
  useEffect(() => {
    const baseUrl = window.location.origin === 'http://localhost:3000' 
      ? 'http://localhost:5000'
      : window.location.origin.replace(':3000', ':5000');
    setApiBaseUrl(baseUrl);
    loadHistory(baseUrl);
  }, []);

  const loadHistory = async (baseUrl) => {
    try {
      const response = await fetch(`${baseUrl}/api/results`);
      const data = await response.json();
      setHistory(data.results || []);
    } catch (err) {
      console.error('이전 결과 로드 실패:', err);
    }
  };

  const handleTextChange = (e) => {
    setTranscriptText(e.target.value);
    setError(null);
  };

  const handleMetadataChange = (e) => {
    const { name, value } = e.target;
    setMetadata(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleProcess = async () => {
    if (!transcriptText.trim()) {
      setError('⚠️ 텍스트를 입력해주세요');
      return;
    }

    setProcessing(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch(`${apiBaseUrl}/api/process-text`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          transcript: transcriptText,
          metadata: metadata
        })
      });

      const data = await response.json();
      
      if (data.success) {
        setResult(data.data);
        await loadHistory(apiBaseUrl);
        alert('✓ 정리가 완료되었습니다!');
      } else {
        throw new Error(data.error);
      }
    } catch (err) {
      setError(`❌ 에러: ${err.message}`);
      console.error(err);
    } finally {
      setProcessing(false);
    }
  };

  const handleExport = async (resultId) => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/export/${resultId}`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error('Word 내보내기 실패');
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `GasTech_Insight_${resultId}.docx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setError(`내보내기 실패: ${err.message}`);
    }
  };

  const handleClearResult = () => {
    setResult(null);
    setTranscriptText('');
    setMetadata({ 
      speakerName: '', 
      speakerTitle: '', 
      date: '',
      source: 'Plaud Note Pro'
    });
  };

  const handleViewResult = async (resultId) => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/results/${resultId}`);
      const data = await response.json();
      setResult(data);
    } catch (err) {
      setError(`결과 로드 실패: ${err.message}`);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-content">
          <h1>🎤 GasTech 2026 - Keynote Insight Organizer</h1>
          <p>Powered by Google Gemini AI</p>
        </div>
      </header>

      <main className="container">
        {error && (
          <div className="error-box">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {result ? (
          <section className="result-section">
            <h2>✓ 정리 완료</h2>
            
            <div className="result-card">
              <div className="result-header">
                <div>
                  <h3>컨퍼런스 키노트 정리</h3>
                  <p className="timestamp">{new Date(result.processedAt).toLocaleString('ko-KR')}</p>
                </div>
                <div className="button-group">
                  <button 
                    className="btn btn-primary"
                    onClick={() => handleExport(result.id)}
                  >
                    📄 Word 다운로드
                  </button>
                  <button 
                    className="btn btn-secondary"
                    onClick={handleClearResult}
                  >
                    새로 시작
                  </button>
                </div>
              </div>

              <div className="result-content">
                <h4>【 정리 내용 】</h4>
                <div className="insight-text">
                  {result.insight.split('\n').map((line, idx) => (
                    <p key={idx}>{line || '\u00A0'}</p>
                  ))}
                </div>
              </div>

              <details className="transcript-section">
                <summary>📋 원본 텍스트</summary>
                <div className="transcript-text">
                  <p>{result.transcript}</p>
                </div>
              </details>
            </div>

            {history.length > 0 && (
              <div className="history-section">
                <h3>📚 이전 정리 목록</h3>
                <div className="history-list">
                  {history.map(item => (
                    <div key={item.id} className="history-item">
                      <div>
                        <span>{item.filename}</span>
                        <small>{new Date(item.processedAt).toLocaleString('ko-KR')}</small>
                      </div>
                      <button 
                        className="btn-small"
                        onClick={() => handleViewResult(item.id)}
                      >
                        보기
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        ) : (
          <section className="upload-section">
            <h2>1️⃣ 텍스트 입력</h2>
            
            <div className="text-input-box">
              <textarea
                value={transcriptText}
                onChange={handleTextChange}
                placeholder="Plaud Note Pro에서 export한 텍스트를 여기에 붙여넣으세요&#10;&#10;또는 Whisper로 변환한 텍스트를 입력하세요"
                className="text-input"
                rows="12"
              />
              {transcriptText && (
                <div className="text-info">
                  <small>입력된 글자 수: {transcriptText.length}</small>
                </div>
              )}
            </div>

            <h2 style={{ marginTop: '2rem' }}>2️⃣ 메타데이터 입력 (선택사항)</h2>
            
            <div className="form-group">
              <input
                type="text"
                name="speakerName"
                placeholder="연사명 (예: Chris Wright)"
                value={metadata.speakerName}
                onChange={handleMetadataChange}
              />
              <input
                type="text"
                name="speakerTitle"
                placeholder="직책/직위 (예: 미국 에너지부 장관)"
                value={metadata.speakerTitle}
                onChange={handleMetadataChange}
              />
              <input
                type="datetime-local"
                name="date"
                placeholder="날짜/시간"
                value={metadata.date}
                onChange={handleMetadataChange}
              />
              <select
                name="source"
                value={metadata.source}
                onChange={handleMetadataChange}
              >
                <option value="Plaud Note Pro">Plaud Note Pro</option>
                <option value="Whisper">Whisper (로컬)</option>
                <option value="기타">기타</option>
              </select>
            </div>

            <h2 style={{ marginTop: '2rem' }}>3️⃣ 정리 시작</h2>
            
            <button
              className={`btn btn-process ${processing ? 'loading' : ''}`}
              onClick={handleProcess}
              disabled={!transcriptText.trim() || processing}
            >
              {processing ? (
                <>
                  <span className="spinner"></span>
                  정리 중... (AI 분석)
                </>
              ) : (
                '▶ 정리 시작'
              )}
            </button>

            {processing && (
              <div className="processing-info">
                <p>⏳ 처리 중...</p>
                <p>Google Gemini AI가 텍스트를 정리하고 있습니다</p>
                <p>10~30초 소요될 수 있습니다</p>
              </div>
            )}

            {history.length > 0 && (
              <div className="history-section" style={{ marginTop: '2rem' }}>
                <h3>📚 최근 정리 목록</h3>
                <div className="history-list">
                  {history.slice(0, 5).map(item => (
                    <div key={item.id} className="history-item">
                      <div>
                        <span>{item.filename}</span>
                        <small>{new Date(item.processedAt).toLocaleString('ko-KR')}</small>
                      </div>
                      <button 
                        className="btn-small"
                        onClick={() => handleViewResult(item.id)}
                      >
                        보기
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </main>

      <footer className="footer">
        <p>🔒 결과물은 안전하게 클라우드에 저장됩니다 | 언제든 접속 가능</p>
        <p>API 제공: Google Gemini API</p>
      </footer>
    </div>
  );
}

export default App;
