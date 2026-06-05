const express = require('express');
const fetch = require('node-fetch');
const app = express();

const EVO_URL = 'https://evolution-api-production-5b7e.up.railway.app';
const EVO_KEY = 'TESTE2';
const EVO_INSTANCE = 'teste';
const PORT = process.env.PORT || 3001;

// CORS — permite o StackBlitz chamar essa API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, apikey');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// Proxy genérico para a Evolution API
async function evoProxy(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${EVO_URL}${path}`, opts);
  return r.json();
}

// ── Grupos ────────────────────────────────────────────────────────────────
app.get('/grupos', async (req, res) => {
  try {
    // Busca todas as conversas
    const chats = await evoProxy(`/chat/findChats/${EVO_INSTANCE}`);
    const list = Array.isArray(chats) ? chats : (chats?.chats || chats?.data || []);

    // Filtra grupos
    const grupoIds = list
      .map(ch => ch.remoteJid || ch.id?.remote || ch.id || '')
      .filter(id => id.includes('@g.us') || id.includes('@lid'))
      .map(id => id.includes('@lid') ? id.replace('@lid', '@g.us') : id);

    // Busca info de cada grupo
    const grupos = [];
    for (const gid of grupoIds.slice(0, 50)) {
      try {
        const info = await evoProxy(`/group/findGroupInfos/${EVO_INSTANCE}?groupJid=${encodeURIComponent(gid)}`);
        const name = info?.subject || info?.name || info?.[0]?.subject || gid.split('@')[0];
        grupos.push({
          id: gid,
          name,
          desc: info?.desc || info?.description || info?.[0]?.desc || '',
          size: info?.size || info?.participants?.length || info?.[0]?.participants?.length || 0,
        });
      } catch {
        grupos.push({ id: gid, name: gid.split('@')[0], desc: '', size: 0 });
      }
    }
    res.json(grupos);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Conversas (espelho WhatsApp) ──────────────────────────────────────────
app.get('/conversas', async (req, res) => {
  try {
    const [chats, contacts] = await Promise.all([
      evoProxy(`/chat/findChats/${EVO_INSTANCE}`),
      evoProxy(`/contacts/fetchContacts/${EVO_INSTANCE}`).catch(() => []),
    ]);
    const list = Array.isArray(chats) ? chats : (chats?.chats || chats?.data || []);
    const contactList = Array.isArray(contacts) ? contacts : (contacts?.data || []);

    const contactMap = {};
    contactList.forEach(c => {
      const jid = c.remoteJid || c.id || '';
      const name = c.pushName || c.name || '';
      if (jid && name) contactMap[jid] = name;
    });

    const conversas = list.slice(0, 50)
      .filter(ch => {
        const id = ch.remoteJid || ch.id?.remote || ch.id || '';
        return !id.includes('@g.us') && !id.includes('@lid') && !id.includes('@broadcast');
      })
      .map(ch => {
        const id = ch.remoteJid || ch.id?.remote || ch.id || '';
        const phone = id.replace('@s.whatsapp.net', '');
        const name = contactMap[id] || ch.name || ch.pushName || phone;
        const lastMsgObj = ch.lastMessage || ch.messages?.upsert?.[0];
        const lastMsg = lastMsgObj?.message?.conversation || lastMsgObj?.message?.extendedTextMessage?.text || '';
        return { id, name, phone, lastMsg, unread: ch.unreadCount || 0 };
      })
      .filter(ch => ch.id);

    res.json(conversas);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Mensagens de uma conversa ─────────────────────────────────────────────
app.get('/mensagens/:jid', async (req, res) => {
  try {
    const jid = decodeURIComponent(req.params.jid);
    const data = await evoProxy(`/chat/findMessages/${EVO_INSTANCE}`, 'POST', {
      where: { key: { remoteJid: jid } },
    });
    const msgs = (data?.messages?.records || []).slice(-50).map(m => ({
      id: m.key?.id || String(Math.random()),
      body: m.message?.conversation || m.message?.extendedTextMessage?.text || '',
      timestamp: m.messageTimestamp || 0,
      fromMe: m.key?.fromMe || false,
    }));
    res.json(msgs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Enviar mensagem ───────────────────────────────────────────────────────
app.post('/enviar', async (req, res) => {
  try {
    const { number, text } = req.body;
    const result = await evoProxy(`/message/sendText/${EVO_INSTANCE}`, 'POST', {
      number,
      textMessage: { text },
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'GL CRM API' }));

app.listen(PORT, () => console.log(`✅ API rodando na porta ${PORT}`));
