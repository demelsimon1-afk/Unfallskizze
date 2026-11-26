module.exports = async function handler(req, res) {
     if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
     const key = process.env.GEMINI_API_KEY;
     if (!key) return res.status(500).json({ error: 'MISSING_KEY' });
     try {
       const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
       const { prompt, imageBase64, mimeType } = body;
       const models = ['gemini-3.8-flash', 'gemini-4-hydrogen', 'gemini-3.6-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'];
       let lastStatus = 503;
       let lastData = { error: 'KI-Server aktuell ausgelastet' };

       for (const model of models) {
         const ctrl = new AbortController();
         const timer = setTimeout(() => ctrl.abort(), 7000);
         try {
           const r = await fetch(
             `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
             {
               method: 'POST',
               signal: ctrl.signal,
               headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
               body: JSON.stringify({
                 contents: [{
                   parts: [
                     { text: prompt },
                     { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } }
                   ]
                 }],
                 generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
               })
             }
           );
           clearTimeout(timer);
           const data = await r.json();
           if (r.ok) return res.status(200).json(data);
           lastStatus = r.status === 404 ? 502 : r.status;
           lastData = data;
           if (r.status !== 404 && r.status !== 503 && r.status !== 429) break;
         } catch (e) {
           clearTimeout(timer);
         }
       }
       return res.status(lastStatus).json(lastData);
     } catch (err) {
       return res.status(500).json({ error: err.message || 'Server error' });
     }
   };
