module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) {
    return res.status(500).json({ error: 'MISSING_KEY' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { prompt, imageBase64, mimeType } = body;

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ error: 'Missing imageBase64' });
    }

    // Dynamische Modell-Auswahl über die API ("Automatic") ohne feste statische Liste
    let activeModel = '';
    try {
      const listRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
        {
          method: 'GET',
          headers: { 'x-goog-api-key': key }
        }
      );
      if (listRes.ok) {
        const listData = await listRes.json();
        const available = Array.isArray(listData?.models) ? listData.models : [];
        const candidate = available.find(m =>
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent') &&
          /flash/i.test(m.name || '')
        ) || available.find(m =>
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent')
        );
        if (candidate?.name) {
          activeModel = candidate.name.replace(/^models\//, '');
        }
      }
    } catch (_) {
      // Fallback-Ermittlung über Standard-Endpunkt unten
    }

    if (!activeModel) {
      activeModel = 'gemini-flash-latest';
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);

    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          signal: ctrl.signal,
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': key
          },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: prompt || 'Extract road geometry and markings as JSON.' },
                {
                  inlineData: {
                    mimeType: mimeType || 'image/jpeg',
                    data: imageBase64
                  }
                }
              ]
            }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.1
            }
          })
        }
      );

      clearTimeout(timer);
      const data = await r.json().catch(() => ({}));
      return res.status(r.status).json(data);
    } catch (err) {
      clearTimeout(timer);
      return res.status(500).json({
        error: err?.name === 'AbortError'
          ? `Timeout (${activeModel})`
          : (err?.message || 'Netzwerkfehler')
      });
    }
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
};
