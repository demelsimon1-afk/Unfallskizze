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
    let sawFreeTierLimitZero = false;

    for (const modelName of candidateModels) {
      // Ältere 2.0-Image-Modelle unterstützen kein imageConfig.aspectRatio
      const supportsImageConfig = /gemini-2\.5|gemini-3/i.test(modelName);

      for (let attempt = 0; attempt < 2; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 16000);

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

          // Google AI Studio Free-Tier setzt bei Image-Modellen oft "limit: 0" (429 RESOURCE_EXHAUSTED)
          const errText = JSON.stringify(data || {});
          if (r.status === 429 && (/limit:\s*0/i.test(errText) || /free_tier/i.test(errText))) {
            sawFreeTierLimitZero = true;
            break;
          }

          // Bei vorübergehender Überlastung einmal kurz warten, sonst nächstes Modell probieren
          if (r.status === 429 || r.status === 503) {
            if (attempt === 0) {
              await sleep(700);
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
            await sleep(500);
            continue;
          }
          break;
        }
      }

      // Wenn Free-Tier limit:0 erkannt wurde, nicht weiter alle Image-Modelle durchprobieren
      if (sawFreeTierLimitZero) break;
    }

    // Automatischer Free-Tier-Fallback: Gemini Vision (gemini-2.5-flash) erkennt Fahrzeuge,
    // Schatten und Grünflächen als exakte Koordinaten, damit das Frontend sie 1:1 bereinigt.
    const visionModels = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
    for (const vModel of visionModels) {
      const vCtrl = new AbortController();
      const vTimer = setTimeout(() => vCtrl.abort(), 16000);
      try {
        const vRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${vModel}:generateContent?key=${encodeURIComponent(key)}`,
          {
            method: 'POST',
            signal: vCtrl.signal,
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': key
            },
            body: JSON.stringify({
              contents: [{
                parts: [
                  {
                    text: [
                      'Analyze this top-down aerial road photo using normalized coordinates from 0 to 1000 (ymin, xmin, ymax, xmax).',
                      'Return ONLY valid JSON with two keys:',
                      '1. "vehicles": array of bounding boxes [ymin, xmin, ymax, xmax] for every vehicle (car, truck, van, motorcycle, bicycle) and dark vehicle shadow on the road.',
                      '2. "vegetation": array of polygons (each polygon is an array of [y, x] points in 0..1000) covering trees, grass, bushes, and green areas OUTSIDE the road curbs.',
                      'Keep all road surfaces, curbs, bike lanes, and road markings completely outside the vegetation polygons.'
                    ].join(' ')
                  },
                  {
                    inlineData: {
                      mimeType: mimeType || 'image/jpeg',
                      data: imageBase64
                    }
                  }
                ]
              }],
              generationConfig: {
                temperature: 0.1,
                responseMimeType: 'application/json'
              }
            })
          }
        );
        clearTimeout(vTimer);

        if (vRes.ok) {
          const vData = await vRes.json().catch(() => ({}));
          const rawText = (vData?.candidates?.[0]?.content?.parts || [])
            .map(p => p.text || '')
            .join('\n')
            .trim();
          const cleanedJson = rawText.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
          const parsed = JSON.parse(cleanedJson);
          return res.status(200).json({
            fallbackMode: 'vision_cleanup',
            model: vModel,
            detections: {
              vehicles: Array.isArray(parsed?.vehicles) ? parsed.vehicles : [],
              vegetation: Array.isArray(parsed?.vegetation) ? parsed.vegetation : []
            }
          });
        }
      } catch (_) {
        clearTimeout(vTimer);
      }
    }

    return res.status(lastStatus).json(lastData);
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
};
