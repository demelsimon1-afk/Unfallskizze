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

    // Verfügbare Gemini-Modelle dynamisch über die Google Models-API ermitteln
    const discoveredImageModels = [];
    const discoveredVisionModels = [];
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
          if (!methods.includes('generateContent')) continue;
          if (/imagen|embedding|tts|audio|live|veo|aqa/i.test(name)) continue;

          if (/image/i.test(name)) {
            discoveredImageModels.push(name);
          } else if (/gemini/i.test(name)) {
            discoveredVisionModels.push(name);
          }
        }
      }
    } catch (_) {
      // Bei Fehler beim Abruf der Modellliste direkt mit den Standard-Modellen fortfahren
    }

    // Bezahlte Bildgenerierungs-Modelle nur abfragen, wenn nicht ausdrücklich "free" gewählt wurde
    if (!isFreeMode) {
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
        ...discoveredImageModels
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
    // Extrahiert Straßenpolygone und Fahrbahnmarkierungen als scharfe Vektorgeometrie.
    if (sawFreeTierLimitZero) {
      const prioritizedDiscovered = discoveredVisionModels.sort((a, b) => {
        const score = (n) => {
          if (/3\.8-flash/i.test(n)) return 1;
          if (/flash-latest/i.test(n)) return 2;
          if (/3\.\d+-flash|3-flash/i.test(n)) return 3;
          if (/2\.5-flash/i.test(n)) return 4;
          if (/flash/i.test(n)) return 5;
          return 10;
        };
        return score(a) - score(b);
      });

      const visionModels = Array.from(new Set([
        'gemini-3.8-flash',
        'gemini-flash-latest',
        ...prioritizedDiscovered,
        'gemini-3-flash-preview',
        'gemini-2.5-flash'
      ].filter(Boolean)));

      const visionErrors = [];

      for (const vModel of visionModels) {
        const genConfigs = [
          { temperature: 0.1, maxOutputTokens: 4096, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
          { temperature: 0.1, maxOutputTokens: 4096, responseMimeType: 'application/json' },
          { temperature: 0.1, maxOutputTokens: 4096 }
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
                          'Extract the road geometry and road markings from this top-down aerial road photo using normalized coordinates from 0 to 1000 (y, x).',
                          'Ignore all cars, trees, grass, shadows, and buildings. Return ONLY a compact valid JSON object with keys:',
                          '1. "roads": array of simplified polygons (each an array of [y, x] points, 4..14 points per polygon) covering the paved road surfaces and intersections.',
                          '2. "solidLines": array of polylines (each an array of [y, x] points) for solid white road edge lines, solid lane dividers, and stop lines.',
                          '3. "dashedLines": array of polylines (each an array of [y, x] points) for dashed white center/lane lines.',
                          '4. "crosswalks": array of [ [y1, x1], [y2, x2] ] start/end pairs ONLY where real zebra crossings are clearly visible.',
                          '5. "arrows": array of [y, x, angleDeg] for directional road arrows (0=right, 90=down, 180=left, 270=up).'
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
                visionErrors.push(`${vModel}: Keine JSON-Antwort`);
                break;
              }
              const parsed = JSON.parse(jsonMatch[0]);
              return res.status(200).json({
                fallbackMode: 'vector_road',
                model: vModel,
                detections: {
                  roads: Array.isArray(parsed?.roads) ? parsed.roads : [],
                  solidLines: Array.isArray(parsed?.solidLines) ? parsed.solidLines : [],
                  dashedLines: Array.isArray(parsed?.dashedLines) ? parsed.dashedLines : [],
                  crosswalks: Array.isArray(parsed?.crosswalks) ? parsed.crosswalks : [],
                  arrows: Array.isArray(parsed?.arrows) ? parsed.arrows : []
                }
              });
            } else {
              const vErr = await vRes.json().catch(() => ({}));
              const errMsg = vErr?.error?.message || `HTTP ${vRes.status}`;
              visionErrors.push(`${vModel}: ${errMsg}`);
              if (vRes.status === 401 || vRes.status === 403) {
                return res.status(vRes.status).json(vErr);
              }
              if (vRes.status !== 400) break;
            }
          } catch (vEx) {
            clearTimeout(vTimer);
            visionErrors.push(`${vModel}: ${vEx?.message || 'Vision-Fehler'}`);
            break;
          }
        }
      }

      const relevantError = visionErrors.find(e => !/no longer available|not found/i.test(e)) || visionErrors[0] || 'Kein Modell verfügbar';
      return res.status(429).json({
        error: `Kostenlose KI-Bereinigung konnte nicht abgeschlossen werden (${relevantError})`
      });
    }

    return res.status(lastStatus).json(lastData);
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
};
