/**
 * Vercel Serverless Function (/api/gemini)
 * Nimmt Prompt, Base64-Luftbild, MIME-Type und optional ein Seitenverhältnis entgegen
 * und ruft ein bildfähiges Gemini-Modell über die Google AI Studio REST-API auf.
 */
module.exports = async function handler(req, res) {
  // CORS- & Preflight-Unterstützung
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

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

    // Verfügbare bildfähige Gemini-Modelle ermitteln (Imagen-Endpunkte ausschließen)
    const discoveredModels = [];
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

        for (const m of available) {
          const name = (m.name || '').replace(/^models\//, '');
          const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
          if (methods.includes('generateContent') && /image/i.test(name) && !/imagen/i.test(name)) {
            discoveredModels.push(name);
          }
        }
      }
    } catch (_) {
      // Bei Fehler beim Abruf der Modellliste direkt mit den Standard-Modellen fortfahren
    }

    // Bewährte Google AI Studio Bildbearbeitungs-Modelle priorisieren
    const candidateModels = Array.from(new Set([
      'gemini-2.5-flash-image',
      'gemini-3.1-flash-image',
      'gemini-2.5-flash-image-preview',
      'gemini-2.0-flash-exp-image-generation',
      'gemini-2.0-flash-preview-image-generation',
      ...discoveredModels
    ].filter(Boolean)));

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    let lastStatus = 502;
    let lastData = { error: 'Kein bildfähiges Gemini-Modell verfügbar' };

    for (const modelName of candidateModels) {
      // Ältere 2.0-Image-Modelle unterstützen kein imageConfig.aspectRatio
      const supportsImageConfig = /gemini-2\.5|gemini-3/i.test(modelName);

      for (let attempt = 0; attempt < 2; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 22000);

        try {
          // Wichtig: Google AI Studio verlangt bei Bildmodellen ['TEXT', 'IMAGE']
          const generationConfig = {
            responseModalities: ['TEXT', 'IMAGE'],
            temperature: 0.1
          };
          if (supportsImageConfig && typeof aspectRatio === 'string' && aspectRatio.trim()) {
            generationConfig.imageConfig = { aspectRatio: aspectRatio.trim() };
          }

          const r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(key)}`,
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
                        mimeType: mimeType || 'image/jpeg',
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
          lastStatus = r.status;
          lastData = data;

          if (r.ok) {
            // Prüfen, ob die Antwort tatsächlich Bilddaten (inlineData) enthält
            const parts = data?.candidates?.[0]?.content?.parts || [];
            const hasImage = parts.some(p => p.inlineData && p.inlineData.data);
            if (hasImage) {
              return res.status(200).json(data);
            }
            // Falls Modell nur Text zurückgab, nächstes Modell testen
            lastStatus = 502;
            lastData = { error: `Modell ${modelName} lieferte kein Bild zurück` };
            break;
          }

          // Bei ungültigem API-Key sofort abbrechen
          if (r.status === 401 || r.status === 403) {
            return res.status(r.status).json(data);
          }

          // Bei vorübergehender Überlastung einmal kurz warten, sonst nächstes Modell probieren
          if (r.status === 429 || r.status === 503) {
            if (attempt === 0) {
              await sleep(900);
              continue;
            }
            break;
          }

          // Bei 400/404 (z.B. Modellname oder Parameter nicht unterstützt) nächstes Modell probieren
          break;
        } catch (err) {
          clearTimeout(timer);
          lastStatus = err?.name === 'AbortError' ? 504 : 500;
          lastData = {
            error: err?.name === 'AbortError'
              ? `Timeout (${modelName})`
              : (err?.message || 'Netzwerkfehler')
          };
          if (attempt === 0) {
            await sleep(700);
            continue;
          }
          break;
        }
      }
    }

    return res.status(lastStatus).json(lastData);
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
};
