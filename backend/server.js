// ════════════════════════════════════════════════════════════
//  SCDP — Backend | Node.js + Express + MongoDB (Mongoose)
//  Sistema de Concessão de Diárias e Passagens
// ════════════════════════════════════════════════════════════

require('dotenv').config();

const BRT = { timeZone: 'America/Sao_Paulo' };
const IS_VERCEL = !!process.env.VERCEL;

let _mongoReady = null;
let _resolveMongoClient, _rejectMongoClient;
const _mongoClientPromise = process.env.MONGODB_URI
  ? new Promise((res, rej) => { _resolveMongoClient = res; _rejectMongoClient = rej; })
  : null;

function _conectarMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  mongoose.set('bufferCommands', false);
  const p = mongoose
    .connect(uri, { serverSelectionTimeoutMS: 12000 })
    .then(() => {
      if (_resolveMongoClient) _resolveMongoClient(mongoose.connection.getClient());
      return garantirAdmin();
    })
    .catch(err => {
      console.error('[MongoDB] Falha na conexão:', err.message);
      _mongoReady = null;
      global._mongoReadyGlobal = null;
      if (_rejectMongoClient) _rejectMongoClient(err);
      throw err;
    });
  global._mongoReadyGlobal = p;
  return p;
}

async function _mongoWaitMiddleware(req, res, next) {
  if (mongoose.connection.readyState === 1) return next();
  if (!_mongoReady) {
    if (!process.env.MONGODB_URI) return res.status(503).json({ erro: 'MONGODB_URI não configurado.' });
    _mongoReady = global._mongoReadyGlobal || _conectarMongo();
  }
  try { await _mongoReady; } catch (e) {
    return res.status(503).json({ erro: 'Banco de dados indisponível. Tente novamente.' });
  }
  next();
}

const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const express   = require('express');
const session   = require('express-session');
const bcrypt    = require('bcryptjs');
const path      = require('path');
const fs        = require('fs');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const http      = require('http');
const mongoose  = require('mongoose');

const app    = express();
const server = IS_VERCEL ? null : http.createServer(app);
const PORT   = process.env.PORT || 3001;

app.set('trust proxy', 1);

const DATA_DIR   = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'SCDP')
  : IS_VERCEL ? '/tmp/SCDP' : __dirname;
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

try {
  [DATA_DIR, BACKUP_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
} catch (e) {
  if (!IS_VERCEL) console.warn('⚠️  Não foi possível criar diretórios:', e.message);
}

// ════════════════════════════════════════════════════════════
//  SCHEMAS MONGODB
// ════════════════════════════════════════════════════════════
const { Schema } = mongoose;

const usuarioSchema = new Schema({
  id:          { type: Number, index: true },
  login:       String,
  senha:       String,
  nome:        String,
  perfil:      { type: String, default: 'visualizador' },
  cor:         String,
  matricula:   String,
  setor:       String,
}, { versionKey: false });

const pcdpSchema = new Schema({
  id:               { type: Number, index: true },
  numero:           String,     // PCDP-2026-001
  servidor:         String,
  matricula:        String,
  cargo:            String,
  setor:            String,
  cpf:              String,
  destino:          String,
  pais:             { type: String, default: 'Brasil' },
  internacional:    { type: Boolean, default: false },
  data_saida:       String,
  data_retorno:     String,
  num_diarias:      Number,
  motivo:           String,
  evento:           String,
  tipo:             String,     // 'Diárias' | 'Passagens' | 'Diárias e Passagens'
  meio_transporte:  String,     // 'Aéreo' | 'Rodoviário' | 'Veículo Próprio' | 'Não se aplica'
  valor_diaria_unit:Number,
  valor_diarias:    Number,
  valor_passagens:  Number,
  valor_total:      Number,
  status:           { type: String, default: 'Rascunho' },
  autorizado_por:   String,
  data_autorizacao: String,
  motivo_rejeicao:  String,
  prazo_prestacao:  String,
  observacoes:      String,
  andamento:        String,
  criado_por:       String,
  criado_em:        String,
  atualizado_em:    String,
}, { versionKey: false });

const prestacaoSchema = new Schema({
  id:                    { type: Number, index: true },
  pcdp_id:               Number,
  pcdp_numero:           String,
  servidor:              String,
  setor:                 String,
  data_saida:            String,
  data_retorno:          String,
  prazo_prestacao:       String,
  valor_diarias_pagas:   { type: Number, default: 0 },
  valor_passagens_pagas: { type: Number, default: 0 },
  valor_total_pago:      { type: Number, default: 0 },
  valor_gasto_diarias:   { type: Number, default: 0 },
  valor_gasto_passagens: { type: Number, default: 0 },
  valor_gasto_outros:    { type: Number, default: 0 },
  valor_total_gasto:     { type: Number, default: 0 },
  saldo:                 { type: Number, default: 0 },  // positivo = devolver, negativo = receber complemento
  status:                { type: String, default: 'Pendente' },
  observacoes:           String,
  criado_por:            String,
  criado_em:             String,
  aprovado_por:          String,
  data_aprovacao:        String,
}, { versionKey: false });

const logSchema = new Schema({
  id:      Number,
  ts:      String,
  login:   String,
  nome:    String,
  perfil:  String,
  tipo:    String,
  acao:    String,
  detalhe: String,
}, { versionKey: false });

const configSchema = new Schema({
  chave: { type: String, unique: true },
  valor: Schema.Types.Mixed,
}, { versionKey: false });

const failedLoginSchema = new Schema({
  _id:          String,
  count:        { type: Number, default: 0 },
  bloqueadoAte: { type: Date, default: null },
}, { versionKey: false });
failedLoginSchema.index({ bloqueadoAte: 1 }, { expireAfterSeconds: 900 });

const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false });

const Usuario     = mongoose.model('Usuario',     usuarioSchema);
const Pcdp        = mongoose.model('Pcdp',        pcdpSchema);
const Prestacao   = mongoose.model('Prestacao',   prestacaoSchema);
const Log         = mongoose.model('Log',         logSchema);
const Config      = mongoose.model('Config',      configSchema);
const FailedLogin = mongoose.model('FailedLogin', failedLoginSchema);
const Counter     = mongoose.model('Counter',     counterSchema);

// ════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════
async function nextId(Model) {
  const r = await Counter.findOneAndUpdate(
    { _id: Model.collection.name },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  ).lean();
  return r.seq;
}

async function getSetores() {
  const cfg = await Config.findOne({ chave: 'setores' }).lean();
  return cfg ? (cfg.valor || []) : [];
}

function agora() {
  return new Date().toLocaleString('pt-BR', BRT);
}

function diasEntre(dataStr) {
  if (!dataStr) return null;
  const partes = dataStr.split('/');
  if (partes.length !== 3) return null;
  const d = new Date(`${partes[2]}-${partes[1]}-${partes[0]}`);
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return Math.ceil((d - hoje) / (1000 * 60 * 60 * 24));
}

function adicionarDias(dataStr, n) {
  const partes = dataStr.split('/');
  const d = new Date(`${partes[2]}-${partes[1]}-${partes[0]}`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('pt-BR');
}

// Campos permitidos — previne NoSQL injection
const CAMPOS_PCDP = [
  'numero','servidor','matricula','cargo','setor','cpf','destino','pais','internacional',
  'data_saida','data_retorno','num_diarias','motivo','evento','tipo','meio_transporte',
  'valor_diaria_unit','valor_diarias','valor_passagens','valor_total','status',
  'autorizado_por','data_autorizacao','motivo_rejeicao','prazo_prestacao',
  'observacoes','andamento','criado_por','criado_em','atualizado_em',
];

const CAMPOS_PRESTACAO = [
  'pcdp_id','pcdp_numero','servidor','setor','data_saida','data_retorno','prazo_prestacao',
  'valor_diarias_pagas','valor_passagens_pagas','valor_total_pago',
  'valor_gasto_diarias','valor_gasto_passagens','valor_gasto_outros','valor_total_gasto',
  'saldo','status','observacoes','aprovado_por','data_aprovacao',
];

function pick(obj, campos) {
  const r = {};
  campos.forEach(k => { if (Object.prototype.hasOwnProperty.call(obj, k)) r[k] = obj[k]; });
  return r;
}

// ════════════════════════════════════════════════════════════
//  ADMIN PADRÃO
// ════════════════════════════════════════════════════════════
async function garantirAdmin() {
  const existe = await Usuario.findOne({ login: 'admin' }).lean();
  if (!existe) {
    const hash = await bcrypt.hash('admin123', 10);
    await Usuario.create({ id: 1, login: 'admin', senha: hash, nome: 'Administrador', perfil: 'admin', cor: '#2563eb' });
    console.log('✅ Admin criado: login=admin senha=admin123');
  }
}

// ════════════════════════════════════════════════════════════
//  BACKUP PERIÓDICO
// ════════════════════════════════════════════════════════════
async function fazerBackup() {
  if (IS_VERCEL) return;
  try {
    const [usuarios, pcdps, prestacoes, logs, setores] = await Promise.all([
      Usuario.find({}, { senha: 0, _id: 0 }).lean(),
      Pcdp.find({}, { _id: 0 }).lean(),
      Prestacao.find({}, { _id: 0 }).lean(),
      Log.find({}, { _id: 0 }).lean(),
      getSetores(),
    ]);
    const destino = path.join(BACKUP_DIR, 'db_backup.json');
    fs.writeFileSync(destino, JSON.stringify({ usuarios, pcdps, prestacoes, logs, setores }, null, 2), 'utf8');
    console.log(`💾 Backup: ${destino}`);
  } catch (err) {
    console.error('❌ Erro no backup:', err.message);
  }
}

// ════════════════════════════════════════════════════════════
//  EXPRESS + MIDDLEWARE
// ════════════════════════════════════════════════════════════
app.use(_mongoWaitMiddleware);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'scdp-secret-2026',
  resave: false,
  saveUninitialized: false,
  store: IS_VERCEL && process.env.MONGODB_URI
    ? require('connect-mongo').create({
        clientPromise: _mongoClientPromise,
        dbName: 'scdp',
        ttl: 24 * 60 * 60,
      })
    : undefined,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_VERCEL,
    maxAge: 24 * 60 * 60 * 1000,
  },
});
app.use(sessionMiddleware);

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ── Servir arquivos estáticos ──────────────────────────────
const ROOT_DIR = path.join(__dirname, '..');
app.use(express.static(ROOT_DIR, { index: false }));

// ════════════════════════════════════════════════════════════
//  AUTH MIDDLEWARE
// ════════════════════════════════════════════════════════════
function auth(req, res, next) {
  if (!req.session?.usuario) return res.status(401).json({ erro: 'Não autenticado' });
  next();
}

function admin(req, res, next) {
  if (!req.session?.usuario) return res.status(401).json({ erro: 'Não autenticado' });
  if (req.session.usuario.perfil !== 'admin') return res.status(403).json({ erro: 'Sem permissão' });
  next();
}

// ════════════════════════════════════════════════════════════
//  LOG
// ════════════════════════════════════════════════════════════
async function registrarLog(req, tipo, acao, detalhe = '') {
  try {
    const u = req.session?.usuario || {};
    const id = await nextId(Log);
    await Log.create({ id, ts: agora(), login: u.login || 'sistema', nome: u.nome || 'Sistema', perfil: u.perfil || '', tipo, acao, detalhe });
  } catch (e) { /* silencioso */ }
}

// ════════════════════════════════════════════════════════════
//  ROTAS — AUTH
// ════════════════════════════════════════════════════════════
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, skipSuccessfulRequests: true });

app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { login, senha } = req.body;
    if (!login || !senha) return res.status(400).json({ erro: 'Login e senha obrigatórios' });

    const bloqueio = await FailedLogin.findById(login.toLowerCase()).lean();
    if (bloqueio?.bloqueadoAte && new Date() < new Date(bloqueio.bloqueadoAte)) {
      const mins = Math.ceil((new Date(bloqueio.bloqueadoAte) - new Date()) / 60000);
      return res.status(429).json({ erro: `Conta bloqueada. Aguarde ${mins} minuto(s).` });
    }

    const u = await Usuario.findOne({ login: login.toLowerCase() }).lean();
    if (!u || !(await bcrypt.compare(senha, u.senha))) {
      await FailedLogin.findByIdAndUpdate(
        login.toLowerCase(),
        { $inc: { count: 1 }, $set: { bloqueadoAte: null } },
        { upsert: true }
      );
      const fl = await FailedLogin.findById(login.toLowerCase()).lean();
      if (fl && fl.count >= 5) {
        await FailedLogin.findByIdAndUpdate(login.toLowerCase(), { bloqueadoAte: new Date(Date.now() + 15 * 60 * 1000) });
        return res.status(429).json({ erro: 'Muitas tentativas. Conta bloqueada por 15 minutos.' });
      }
      return res.status(401).json({ erro: 'Usuário ou senha incorretos' });
    }

    await FailedLogin.deleteOne({ _id: login.toLowerCase() });
    req.session.usuario = { id: u.id, login: u.login, nome: u.nome, perfil: u.perfil, cor: u.cor };
    await registrarLog(req, 'auth', 'login', `Login de ${u.login}`);
    res.json({ ok: true, usuario: req.session.usuario });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

app.post('/api/logout', auth, async (req, res) => {
  await registrarLog(req, 'auth', 'logout', `Logout de ${req.session.usuario?.login}`);
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session?.usuario) return res.status(401).json({ erro: 'Não autenticado' });
  res.json(req.session.usuario);
});

// ════════════════════════════════════════════════════════════
//  ROTAS — PCDPs
// ════════════════════════════════════════════════════════════
app.get('/api/pcdps', auth, async (req, res) => {
  try {
    const pcdps = await Pcdp.find({}).sort({ id: -1 }).lean();
    res.json(pcdps);
  } catch (e) { res.status(500).json({ erro: 'Erro ao buscar PCDPs' }); }
});

app.post('/api/pcdps', auth, async (req, res) => {
  try {
    const dados = pick(req.body, CAMPOS_PCDP);
    const id = await nextId(Pcdp);
    const ano = new Date().getFullYear();
    dados.id = id;
    dados.numero = dados.numero || `PCDP-${ano}-${String(id).padStart(4, '0')}`;
    dados.status = dados.status || 'Rascunho';
    dados.criado_por = req.session.usuario.nome;
    dados.criado_em = agora();
    dados.atualizado_em = agora();

    // Prazo de prestação = data_retorno + 5 dias úteis (aproximado: +7 dias corridos)
    if (dados.data_retorno) {
      dados.prazo_prestacao = adicionarDias(dados.data_retorno, 7);
    }

    const pcdp = await Pcdp.create(dados);
    await registrarLog(req, 'pcdp', 'criar', `PCDP ${dados.numero} criada`);
    res.status(201).json(pcdp);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao criar PCDP' });
  }
});

app.put('/api/pcdps/:id', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const dados = pick(req.body, CAMPOS_PCDP);
    dados.atualizado_em = agora();
    if (dados.data_retorno) dados.prazo_prestacao = adicionarDias(dados.data_retorno, 7);

    const pcdp = await Pcdp.findOneAndUpdate({ id }, { $set: dados }, { new: true }).lean();
    if (!pcdp) return res.status(404).json({ erro: 'PCDP não encontrada' });
    await registrarLog(req, 'pcdp', 'editar', `PCDP ${pcdp.numero} editada`);
    res.json(pcdp);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao editar PCDP' });
  }
});

app.delete('/api/pcdps/:id', admin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const pcdp = await Pcdp.findOneAndDelete({ id }).lean();
    if (!pcdp) return res.status(404).json({ erro: 'PCDP não encontrada' });
    await registrarLog(req, 'pcdp', 'excluir', `PCDP ${pcdp.numero} excluída`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: 'Erro ao excluir PCDP' }); }
});

// Transições de status
app.patch('/api/pcdps/:id/status', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status, motivo_rejeicao, autorizado_por } = req.body;

    const STATUS_VALIDOS = ['Rascunho','Aguardando Aprovação','Aprovada','Rejeitada','Em Viagem','Prestação de Contas','Finalizada','Cancelada'];
    if (!STATUS_VALIDOS.includes(status)) return res.status(400).json({ erro: 'Status inválido' });

    const upd = { status, atualizado_em: agora() };
    if (motivo_rejeicao) upd.motivo_rejeicao = motivo_rejeicao;
    if (autorizado_por) {
      upd.autorizado_por = autorizado_por;
      upd.data_autorizacao = agora();
    }

    const pcdp = await Pcdp.findOneAndUpdate({ id }, { $set: upd }, { new: true }).lean();
    if (!pcdp) return res.status(404).json({ erro: 'PCDP não encontrada' });

    // Se mudou para "Prestação de Contas", cria/garante prestação vinculada
    if (status === 'Prestação de Contas') {
      const existe = await Prestacao.findOne({ pcdp_id: pcdp.id }).lean();
      if (!existe) {
        const pid = await nextId(Prestacao);
        await Prestacao.create({
          id: pid, pcdp_id: pcdp.id, pcdp_numero: pcdp.numero,
          servidor: pcdp.servidor, setor: pcdp.setor,
          data_saida: pcdp.data_saida, data_retorno: pcdp.data_retorno,
          prazo_prestacao: pcdp.prazo_prestacao,
          valor_diarias_pagas: pcdp.valor_diarias || 0,
          valor_passagens_pagas: pcdp.valor_passagens || 0,
          valor_total_pago: pcdp.valor_total || 0,
          status: 'Pendente',
          criado_por: req.session.usuario.nome,
          criado_em: agora(),
        });
      }
    }

    await registrarLog(req, 'pcdp', 'status', `PCDP ${pcdp.numero} → ${status}`);
    res.json(pcdp);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao atualizar status' });
  }
});

// ════════════════════════════════════════════════════════════
//  ROTAS — PRESTAÇÕES DE CONTAS
// ════════════════════════════════════════════════════════════
app.get('/api/prestacoes', auth, async (req, res) => {
  try {
    const prestacoes = await Prestacao.find({}).sort({ id: -1 }).lean();
    res.json(prestacoes);
  } catch (e) { res.status(500).json({ erro: 'Erro ao buscar prestações' }); }
});

app.put('/api/prestacoes/:id', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const dados = pick(req.body, CAMPOS_PRESTACAO);

    // Recalcula saldo: positivo = deve devolver, negativo = deve receber
    const total_pago = parseFloat(dados.valor_total_pago || 0);
    const total_gasto = parseFloat(dados.valor_total_gasto || 0);
    dados.saldo = Math.round((total_pago - total_gasto) * 100) / 100;

    const prest = await Prestacao.findOneAndUpdate({ id }, { $set: dados }, { new: true }).lean();
    if (!prest) return res.status(404).json({ erro: 'Prestação não encontrada' });
    await registrarLog(req, 'prestacao', 'editar', `Prestação de ${prest.pcdp_numero} editada`);
    res.json(prest);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao editar prestação' });
  }
});

app.patch('/api/prestacoes/:id/status', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status } = req.body;
    const STATUS_VALIDOS = ['Pendente','Em análise','Aprovada','Com pendências'];
    if (!STATUS_VALIDOS.includes(status)) return res.status(400).json({ erro: 'Status inválido' });

    const upd = { status };
    if (status === 'Aprovada') {
      upd.aprovado_por = req.session.usuario.nome;
      upd.data_aprovacao = agora();
    }

    const prest = await Prestacao.findOneAndUpdate({ id }, { $set: upd }, { new: true }).lean();
    if (!prest) return res.status(404).json({ erro: 'Prestação não encontrada' });

    // Se aprovada, finaliza a PCDP
    if (status === 'Aprovada') {
      await Pcdp.findOneAndUpdate({ id: prest.pcdp_id }, { $set: { status: 'Finalizada', atualizado_em: agora() } });
    }

    await registrarLog(req, 'prestacao', 'status', `Prestação de ${prest.pcdp_numero} → ${status}`);
    res.json(prest);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao atualizar status da prestação' });
  }
});

// ════════════════════════════════════════════════════════════
//  ROTAS — DASHBOARD
// ════════════════════════════════════════════════════════════
app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const [pcdps, prestacoes, setores] = await Promise.all([
      Pcdp.find({}).lean(),
      Prestacao.find({}).lean(),
      getSetores(),
    ]);

    // KPIs gerais
    const total      = pcdps.length;
    const rascunho   = pcdps.filter(p => p.status === 'Rascunho').length;
    const aguardando = pcdps.filter(p => p.status === 'Aguardando Aprovação').length;
    const aprovadas  = pcdps.filter(p => p.status === 'Aprovada').length;
    const rejeitadas = pcdps.filter(p => p.status === 'Rejeitada').length;
    const em_viagem  = pcdps.filter(p => p.status === 'Em Viagem').length;
    const prestando  = pcdps.filter(p => p.status === 'Prestação de Contas').length;
    const finalizadas= pcdps.filter(p => p.status === 'Finalizada').length;
    const canceladas = pcdps.filter(p => p.status === 'Cancelada').length;

    // KPIs financeiros
    const total_diarias   = pcdps.reduce((s, p) => s + (p.valor_diarias || 0), 0);
    const total_passagens = pcdps.reduce((s, p) => s + (p.valor_passagens || 0), 0);
    const total_valor     = pcdps.reduce((s, p) => s + (p.valor_total || 0), 0);

    // Prestações
    const prest_pendentes = prestacoes.filter(p => p.status === 'Pendente').length;
    const prest_analise   = prestacoes.filter(p => p.status === 'Em análise').length;
    const prest_aprovadas = prestacoes.filter(p => p.status === 'Aprovada').length;
    const prest_pendencias= prestacoes.filter(p => p.status === 'Com pendências').length;

    // PCDPs por status (para gráfico)
    const por_status = [
      { status: 'Rascunho', qtd: rascunho, cor: '#94a3b8' },
      { status: 'Aguardando', qtd: aguardando, cor: '#f59e0b' },
      { status: 'Aprovada', qtd: aprovadas, cor: '#10b981' },
      { status: 'Em Viagem', qtd: em_viagem, cor: '#8b5cf6' },
      { status: 'Prestação', qtd: prestando, cor: '#f97316' },
      { status: 'Finalizada', qtd: finalizadas, cor: '#3b82f6' },
      { status: 'Rejeitada', qtd: rejeitadas, cor: '#ef4444' },
      { status: 'Cancelada', qtd: canceladas, cor: '#6b7280' },
    ].filter(x => x.qtd > 0);

    // PCDPs por setor (top 8)
    const por_setor_map = {};
    pcdps.forEach(p => { if (p.setor) por_setor_map[p.setor] = (por_setor_map[p.setor] || 0) + 1; });
    const por_setor = Object.entries(por_setor_map)
      .map(([s, q]) => ({ setor: s, qtd: q }))
      .sort((a, b) => b.qtd - a.qtd).slice(0, 8);

    // Gastos por mês (últimos 12 meses)
    const gastosMes = {};
    pcdps.forEach(p => {
      if (!p.data_saida) return;
      const partes = p.data_saida.split('/');
      if (partes.length < 3) return;
      const chave = `${partes[1]}/${partes[2]}`;
      if (!gastosMes[chave]) gastosMes[chave] = { diarias: 0, passagens: 0 };
      gastosMes[chave].diarias   += (p.valor_diarias || 0);
      gastosMes[chave].passagens += (p.valor_passagens || 0);
    });
    const gastos_por_mes = Object.entries(gastosMes)
      .sort((a, b) => {
        const [ma, aa] = a[0].split('/');
        const [mb, ab] = b[0].split('/');
        return new Date(`${aa}-${ma}-01`) - new Date(`${ab}-${mb}-01`);
      })
      .slice(-12)
      .map(([mes, v]) => ({ mes, ...v, total: v.diarias + v.passagens }));

    // Alertas: prestações vencendo/vencidas
    const alertas_prestacao = prestacoes
      .filter(p => p.status === 'Pendente' || p.status === 'Em análise')
      .map(p => ({ ...p, dias: diasEntre(p.prazo_prestacao) }))
      .filter(p => p.dias !== null && p.dias <= 5)
      .sort((a, b) => a.dias - b.dias)
      .slice(0, 5);

    // PCDPs aguardando aprovação há mais tempo
    const alertas_aguardando = pcdps
      .filter(p => p.status === 'Aguardando Aprovação')
      .slice(0, 5);

    res.json({
      kpis: {
        total, rascunho, aguardando, aprovadas, rejeitadas,
        em_viagem, prestando, finalizadas, canceladas,
        total_diarias, total_passagens, total_valor,
        prest_pendentes, prest_analise, prest_aprovadas, prest_pendencias,
      },
      graficos: { por_status, por_setor, gastos_por_mes },
      alertas: { prestacao: alertas_prestacao, aguardando: alertas_aguardando },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro no dashboard' });
  }
});

// ════════════════════════════════════════════════════════════
//  ROTAS — PRAZOS
// ════════════════════════════════════════════════════════════
app.get('/api/prazos', auth, async (req, res) => {
  try {
    const [pcdps, prestacoes] = await Promise.all([
      Pcdp.find({ status: { $in: ['Aguardando Aprovação', 'Aprovada', 'Em Viagem', 'Prestação de Contas'] } }).lean(),
      Prestacao.find({ status: { $in: ['Pendente', 'Em análise', 'Com pendências'] } }).lean(),
    ]);

    const itens = [];

    prestacoes.forEach(p => {
      const dias = diasEntre(p.prazo_prestacao);
      itens.push({
        tipo: 'prestacao',
        id: p.id,
        numero: p.pcdp_numero,
        titulo: `Prestação de Contas — ${p.servidor}`,
        detalhe: `Prazo: ${p.prazo_prestacao || '—'} · Status: ${p.status}`,
        dias,
        status: p.status,
        pcdp_id: p.pcdp_id,
      });
    });

    pcdps.filter(p => p.status === 'Aguardando Aprovação').forEach(p => {
      itens.push({
        tipo: 'aprovacao',
        id: p.id,
        numero: p.numero,
        titulo: `Aguardando Aprovação — ${p.servidor}`,
        detalhe: `Destino: ${p.destino || '—'} · Saída: ${p.data_saida || '—'}`,
        dias: diasEntre(p.data_saida),
        status: p.status,
      });
    });

    pcdps.filter(p => p.status === 'Aprovada').forEach(p => {
      const dias = diasEntre(p.data_saida);
      if (dias !== null && dias <= 7) {
        itens.push({
          tipo: 'viagem',
          id: p.id,
          numero: p.numero,
          titulo: `Viagem em ${dias <= 0 ? 'andamento' : dias + ' dia(s)'} — ${p.servidor}`,
          detalhe: `Destino: ${p.destino || '—'} · ${p.data_saida} → ${p.data_retorno}`,
          dias,
          status: p.status,
        });
      }
    });

    itens.sort((a, b) => {
      const da = a.dias === null ? 999 : a.dias;
      const db = b.dias === null ? 999 : b.dias;
      return da - db;
    });

    res.json(itens);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar prazos' });
  }
});

// ════════════════════════════════════════════════════════════
//  ROTAS — USUÁRIOS
// ════════════════════════════════════════════════════════════
app.get('/api/usuarios', admin, async (req, res) => {
  try {
    const usuarios = await Usuario.find({}, { senha: 0 }).sort({ id: 1 }).lean();
    res.json(usuarios);
  } catch (e) { res.status(500).json({ erro: 'Erro ao buscar usuários' }); }
});

app.post('/api/usuarios', admin, async (req, res) => {
  try {
    const { login, senha, nome, perfil, setor } = req.body;
    if (!login || !senha || !nome) return res.status(400).json({ erro: 'Campos obrigatórios: login, senha, nome' });
    const existe = await Usuario.findOne({ login: login.toLowerCase() }).lean();
    if (existe) return res.status(409).json({ erro: 'Login já existe' });

    const cores = ['#2563eb','#7c3aed','#059669','#d97706','#dc2626','#0891b2','#be185d','#65a30d'];
    const totalUsers = await Usuario.countDocuments();
    const hash = await bcrypt.hash(senha, 10);
    const id = await nextId(Usuario);
    const u = await Usuario.create({
      id, login: login.toLowerCase(), senha: hash, nome, perfil: perfil || 'visualizador',
      setor: setor || '', cor: cores[totalUsers % cores.length],
    });
    await registrarLog(req, 'usuario', 'criar', `Usuário ${login} criado`);
    res.status(201).json({ id: u.id, login: u.login, nome: u.nome, perfil: u.perfil, setor: u.setor });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao criar usuário' });
  }
});

app.put('/api/usuarios/:id', admin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { nome, perfil, setor, senha } = req.body;
    const upd = {};
    if (nome) upd.nome = nome;
    if (perfil) upd.perfil = perfil;
    if (setor !== undefined) upd.setor = setor;
    if (senha) upd.senha = await bcrypt.hash(senha, 10);
    await Usuario.findOneAndUpdate({ id }, { $set: upd });
    await registrarLog(req, 'usuario', 'editar', `Usuário id=${id} atualizado`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: 'Erro ao atualizar usuário' }); }
});

app.delete('/api/usuarios/:id', admin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (id === req.session.usuario.id) return res.status(400).json({ erro: 'Não é possível excluir a própria conta' });
    await Usuario.findOneAndDelete({ id });
    await registrarLog(req, 'usuario', 'excluir', `Usuário id=${id} excluído`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: 'Erro ao excluir usuário' }); }
});

app.patch('/api/usuarios/:id/senha', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (req.session.usuario.id !== id && req.session.usuario.perfil !== 'admin')
      return res.status(403).json({ erro: 'Sem permissão' });
    const { senha_atual, nova_senha } = req.body;
    if (!nova_senha || nova_senha.length < 6) return res.status(400).json({ erro: 'Senha mínimo 6 caracteres' });
    const u = await Usuario.findOne({ id }).lean();
    if (!u) return res.status(404).json({ erro: 'Usuário não encontrado' });
    if (req.session.usuario.perfil !== 'admin') {
      if (!senha_atual || !(await bcrypt.compare(senha_atual, u.senha)))
        return res.status(401).json({ erro: 'Senha atual incorreta' });
    }
    await Usuario.findOneAndUpdate({ id }, { $set: { senha: await bcrypt.hash(nova_senha, 10) } });
    await registrarLog(req, 'usuario', 'senha', `Senha de id=${id} alterada`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: 'Erro ao alterar senha' }); }
});

// ════════════════════════════════════════════════════════════
//  ROTAS — SETORES
// ════════════════════════════════════════════════════════════
app.get('/api/setores', auth, async (req, res) => {
  res.json(await getSetores());
});

app.post('/api/setores', admin, async (req, res) => {
  try {
    const { setores } = req.body;
    if (!Array.isArray(setores)) return res.status(400).json({ erro: 'setores deve ser array' });
    await Config.updateOne({ chave: 'setores' }, { valor: setores.map(s => s.trim()).filter(Boolean) }, { upsert: true });
    await registrarLog(req, 'config', 'setores', 'Setores atualizados');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: 'Erro ao salvar setores' }); }
});

// ════════════════════════════════════════════════════════════
//  ROTAS — LOGS
// ════════════════════════════════════════════════════════════
app.get('/api/logs', admin, async (req, res) => {
  try {
    const logs = await Log.find({}).sort({ id: -1 }).limit(500).lean();
    res.json(logs);
  } catch (e) { res.status(500).json({ erro: 'Erro ao buscar logs' }); }
});

// ════════════════════════════════════════════════════════════
//  ROTAS — HEALTH + BACKUP
// ════════════════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  const ok = mongoose.connection.readyState === 1;
  res.json({ ok, db: ok ? 'conectado' : 'desconectado', ts: agora() });
});

app.post('/api/backup', admin, async (req, res) => {
  await fazerBackup();
  res.json({ ok: true });
});

// ── Servir HTML para todas as rotas não-API ───────────────
app.get('*', (req, res) => {
  const html = path.join(ROOT_DIR, 'sistema_scdp.html');
  if (fs.existsSync(html)) return res.sendFile(html);
  res.status(404).send('sistema_scdp.html não encontrado');
});

// ════════════════════════════════════════════════════════════
//  INICIALIZAÇÃO
// ════════════════════════════════════════════════════════════
if (!IS_VERCEL) {
  const uri = process.env.MONGODB_URI;
  if (uri) {
    mongoose.connect(uri).then(() => {
      console.log('✅ MongoDB conectado');
      return garantirAdmin();
    }).then(() => {
      setInterval(fazerBackup, 2 * 60 * 60 * 1000);
    }).catch(err => console.error('❌ MongoDB:', err.message));
  } else {
    console.warn('⚠️  MONGODB_URI não definido — defina no .env');
  }

  server.listen(PORT, () => console.log(`🚀 SCDP rodando em http://localhost:${PORT}`));
}

module.exports = app;
