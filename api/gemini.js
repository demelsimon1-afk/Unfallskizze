/**
 * Vercel Serverless Function (/api/gemini)
 * Nimmt Prompt, Base64-Luftbild, MIME-Type, Seitenverhältnis sowie Qualitätsstufe entgegen
 * und ruft ein bildfähiges Gemini-Modell (inkl. Gemini 3 Pro Image / 2K) über die REST-API auf.
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
    const { prompt, imageBase64, mimeType, aspectRatio, modelTier, imageSize } = body;

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ error: 'Missing imageBase64' });
    }

    const isFreeMode = !modelTier || modelTier === 'free';
    let lastStatus = 502;
    let lastData = { error: 'Kein bildfähiges Gemini-Modell verfügbar' };
    let sawFreeTierLimitZero = isFreeMode;

    // Bezahlte Bildgenerierungs-Modelle nur abfragen, wenn nicht ausdrücklich "free" gewählt wurde
    if (!isFreeMode) {
      // Verfügbare bildfähige Gemini-Modelle über die Models-API ermitteln (Imagen-Endpunkte ausschließen)
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

      // Hochwertige Gemini-3-Pro- & 3.1-Flash-Bildmodelle je nach gewählter Qualitätsstufe priorisieren
      const tierPresets = {
        pro: [
          'gemini-3-pro-image-preview',
          'gemini-3-pro-image',
          'gemini-3.1-flash-image-preview',
          'gemini-3.1-flash-image',
          'gemini-2.5-flash-image'
        ],
        flash3: [
          'gemini-3.1-flash-image-preview',
          'gemini-3.1-flash-image',
          'gemini-3-pro-image-preview',
          'gemini-3-pro-image',
          'gemini-2.5-flash-image'
        ],
        flash25: [
          'gemini-2.5-flash-image',
          'gemini-3.1-flash-image-preview',
          'gemini-3-pro-image-preview'
        ]
      };

      const selectedPreset = tierPresets[modelTier] || tierPresets.pro;
      const candidateModels = Array.from(new Set([
        ...selectedPreset,
        ...discoveredModels
      ].filter(Boolean)));

      const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

      for (const modelName of candidateModels) {
        const isGemini3 = /gemini-3/i.test(modelName);
        const supportsImageConfig = /gemini-2\.5|gemini-3/i.test(modelName);
        const requestedSize = (typeof imageSize === 'string' && imageSize.trim()) ? imageSize.trim() : '2K';

        const configVariants = [];
        if (isGemini3 && typeof aspectRatio === 'string' && aspectRatio.trim()) {
          configVariants.push({
            responseModalities: ['TEXT', 'IMAGE'],
            temperature: 0.1,
            imageConfig: { aspectRatio: aspectRatio.trim(), imageSize: requestedSize }
          });
        }
        if (supportsImageConfig && typeof aspectRatio === 'string' && aspectRatio.trim()) {
          configVariants.push({
            responseModalities: ['TEXT', 'IMAGE'],
            temperature: 0.1,
            imageConfig: { aspectRatio: aspectRatio.trim() }
          });
        } else {
          configVariants.push({
            responseModalities: ['TEXT', 'IMAGE'],
            temperature: 0.1
          });
        }

        for (const generationConfig of configVariants) {
          let moveNextModel = false;

          for (let attempt = 0; attempt < 2; attempt++) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 45000);

            try {
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
                const parts = data?.candidates?.[0]?.content?.parts || [];
                const hasImage = parts.some(p => p.inlineData && p.inlineData.data);
                if (hasImage) {
                  return res.status(200).json({ ...data, usedModel: modelName });
                }
                lastStatus = 502;
                lastData = { error: `Modell ${modelName} lieferte kein Bild zurück` };
                moveNextModel = true;
                break;
              }

              if (r.status === 401 || r.status === 403) {
                return res.status(r.status).json(data);
              }

              const errText = JSON.stringify(data || {});
              if (r.status === 429 && (/limit:\s*0/i.test(errText) || /free_tier/i.test(errText))) {
                sawFreeTierLimitZero = true;
                moveNextModel = true;
                break;
              }

              if (r.status === 429 || r.status === 503) {
                if (attempt === 0) {
                  await sleep(900);
                  continue;
                }
                moveNextModel = true;
                break;
              }

              if (r.status === 400) {
                break;
              }

              moveNextModel = true;
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
              moveNextModel = true;
              break;
            }
          }

          if (moveNextModel) break;
        }

        if (sawFreeTierLimitZero) break;
      }
    }

    // 100 % kostenloser Free-Tier-Modus (ohne Guthaben / ohne Abrechnungskonto):
    // Nutzt kostenlose Flash-Vision-Modelle mit deaktiviertem Thinking-Budget für schnelle, präzise Objekterkennung.
    if (sawFreeTierLimitZero) {
      const visionModels = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];
      let lastVisionError = '';

      for (const vModel of visionModels) {
        const genConfigs = [
          { temperature: 0.1, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
          { temperature: 0.1, responseMimeType: 'application/json' }
        ];

        for (const genCfg of genConfigs) {
          const vCtrl = new AbortController();
          const vTimer = setTimeout(() => vCtrl.abort(), 24000);
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
                          'Return ONLY a valid JSON object with two keys:',
                          '1. "vehicles": array of tight bounding boxes [ymin, xmin, ymax, xmax] for every vehicle (car, truck, van, bus, motorcycle, bicycle) and dark vehicle shadow on the road.',
                          '2. "vegetation": array of polygons (each polygon is an array of [y, x] points in 0..1000) covering trees, grass, bushes, gardens, and buildings OUTSIDE the road curbs and sidewalks.',
                          'Keep all road surfaces, curbs, bike lanes, sidewalks, and road markings completely outside the vegetation polygons.'
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
                  generationConfig: genCfg
                })
              }
            );
            clearTimeout(vTimer);

            if (vRes.ok) {
              const vData = await vRes.json().catch(() => ({}));
              const parts = vData?.candidates?.[0]?.content?.parts || [];
              const rawText = parts
                .filter(p => !p.thought && typeof p.text === 'string')
                .map(p => p.text)
                .join('\n')
                .trim();
              const jsonMatch = rawText.match(/\{[\s\S]*\}/);
              if (!jsonMatch) {
                lastVisionError = `${vModel}: Keine JSON-Antwort`;
                break;
              }
              const parsed = JSON.parse(jsonMatch[0]);
              return res.status(200).json({
                fallbackMode: 'vision_cleanup',
                model: vModel,
                detections: {
                  vehicles: Array.isArray(parsed?.vehicles) ? parsed.vehicles : [],
                  vegetation: Array.isArray(parsed?.vegetation) ? parsed.vegetation : []
                }
              });
            } else {
              const vErr = await vRes.json().catch(() => ({}));
              lastVisionError = vErr?.error?.message || `HTTP ${vRes.status}`;
              if (vRes.status === 401 || vRes.status === 403) {
                return res.status(vRes.status).json(vErr);
              }
              if (vRes.status !== 400) break;
            }
          } catch (vEx) {
            clearTimeout(vTimer);
            lastVisionError = vEx?.message || 'Vision-Fehler';
            break;
          }
        }
      }

      return res.status(429).json({
        error: `Kostenlose KI-Bereinigung konnte nicht abgeschlossen werden: ${lastVisionError}`
      });
    }

    return res.status(lastStatus).json(lastData);
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
};
