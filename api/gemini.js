/**
 * Vercel Serverless Function (/api/gemini)
 * Nimmt Prompt, Base64-Luftbild, MIME-Type und optional ein Seitenverhältnis entgegen
 * und ruft ein passendes Gemini-Bildmodell über die REST-API auf.
 */
module.exports = async function handler(req, res) {
  // Nur POST-Anfragen zulassen
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // API-Key aus den Vercel-Umgebungsvariablen auslesen
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) {
    return res.status(500).json({ error: 'MISSING_KEY' });
  }

  try {
    // Request-Body sicher parsen (unterstützt JSON-String und bereits geparste Objekte)
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { prompt, imageBase64, mimeType, aspectRatio } = body;

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ error: 'Missing imageBase64' });
    }

    // Dynamisch ein verfügbares Gemini-Modell über die Models-API ermitteln
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

        // Bevorzugt ein Modell mit Bildgenerierung / Flash-Image wählen, sonst Standard-generateContent-Modell
        const imageCapable = available.find(m =>
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent') &&
          /image/i.test(m.name || '')
        );
        const flashOrPro = available.find(m =>
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent') &&
          /(flash|pro)/i.test(m.name || '')
        );
        const anyContentModel = available.find(m =>
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent')
        );

        const chosen = imageCapable || flashOrPro || anyContentModel;
        if (chosen?.name) {
          activeModel = chosen.name.replace(/^models\//, '');
        }
      }
    } catch (_) {
      // Bei Fehler beim Abruf der Modellliste auf bewährten Standard zurückfallen
    }

    if (!activeModel) {
      activeModel = 'gemini-3.1-flash-image';
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 14000);

    try {
      // generationConfig auf Bildausgabe abstimmen, damit das Frontend inlineData direkt nutzen kann
      const generationConfig = {
        responseModalities: ['IMAGE'],
        temperature: 0.1
      };
      if (typeof aspectRatio === 'string' && aspectRatio.trim()) {
        generationConfig.imageConfig = { aspectRatio: aspectRatio.trim() };
      }

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
                {
                  text:
                    prompt ||
                    'Edit this aerial road photo at 1:1 alignment: remove vehicles, shadows, and outside vegetation while keeping existing roads and markings unchanged.'
                },
                {
                  inlineData: {
                    mimeType: mimeType || 'image/png',
                    data: imageBase64
                  }
                }
              ]
            }],
            generationConfig
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
