module.exports = async function handler(req, res) {
     if (req.method !== 'POST') {
       return res.status(405).json({ error: 'Method not allowed' });
     }
     const key = process.env.GEMINI_API_KEY;
     if (!key) {
       return res.status(500).json({ error: 'MISSING_KEY' });
     }
     try {
       const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
       const { prompt, imageBase64 } = body;
       const r = await fetch(
         `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`,
         {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({
             contents: [{
               parts: [
                 { text: prompt },
                 { inlineData: { mimeType: 'image/png', data: imageBase64 } }
               ]
             }],
             generationConfig: {
               responseMimeType: 'application/json',
               temperature: 0.1
             }
           })
         }
       );
       const data = await r.json();
       return res.status(r.status).json(data);
     } catch (err) {
       return res.status(500).json({ error: err.message || 'Server error' });
     }
   };
