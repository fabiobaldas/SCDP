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
  cpf:         String,
  secretaria:  String,
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
  uf:               String,
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
  origem_passagem:  String,
  destino_passagem: String,
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

const solicitacaoSchema = new Schema({
  id:           { type: Number, index: true },
  nome:         String,
  login:        String,
  matricula:    String,
  cpf:          String,
  secretaria:   String,
  setor:        String,
  justificativa:String,
  perfil:       { type: String, default: 'servidor' },
  status:       { type: String, default: 'Pendente' }, // Pendente | Aprovada | Rejeitada
  criado_em:    String,
  resolvido_em: String,
  resolvido_por:String,
}, { versionKey: false });

const Usuario     = mongoose.model('Usuario',     usuarioSchema);
const Pcdp        = mongoose.model('Pcdp',        pcdpSchema);
const Prestacao   = mongoose.model('Prestacao',   prestacaoSchema);
const Log         = mongoose.model('Log',         logSchema);
const Config      = mongoose.model('Config',      configSchema);
const FailedLogin = mongoose.model('FailedLogin', failedLoginSchema);
const Counter     = mongoose.model('Counter',     counterSchema);
const Solicitacao = mongoose.model('Solicitacao', solicitacaoSchema);

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

async function getSecretarias() {
  const cfg = await Config.findOne({ chave: 'secretarias' }).lean();
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
  'numero','servidor','matricula','cargo','setor','cpf','destino','uf','pais','internacional',
  'data_saida','data_retorno','num_diarias','motivo','evento','tipo','meio_transporte',
  'valor_diaria_unit','valor_diarias','valor_passagens','valor_total',
  'origem_passagem','destino_passagem',
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
const ADMIN_CPF = '11111111193'; // CPF do admin: 111.111.111-93

async function garantirAdmin() {
  // Migrar admin antigo (login='admin') para CPF
  const adminAntigo = await Usuario.findOne({ login: 'admin' }).lean();
  if (adminAntigo) {
    await Usuario.updateOne({ login: 'admin' }, { $set: { login: ADMIN_CPF, cpf: '111.111.111-93' } });
    console.log(`✅ Admin migrado: login "admin" → CPF ${ADMIN_CPF}`);
  }
  // Criar admin se ainda não existir
  const existe = await Usuario.findOne({ login: ADMIN_CPF }).lean();
  if (!existe) {
    const hash = await bcrypt.hash('admin123', 10);
    await Usuario.create({ id: 1, login: ADMIN_CPF, senha: hash, nome: 'Administrador', perfil: 'admin', cor: '#2563eb', cpf: '111.111.111-93' });
    console.log(`✅ Admin criado: CPF=111.111.111-93  senha=admin123`);
  }
  // Garante que o Counter de usuários nunca colida com admin (id=1)
  await Counter.updateOne(
    { _id: 'usuarios' },
    [{ $set: { seq: { $max: ['$seq', 1] } } }],
    { upsert: true }
  );
}

// Corrige IDs duplicados causados pela criação de admin com id=1 sem inicializar o counter
async function repararIdsUsuarios() {
  try {
    const usuarios = await Usuario.find({}).sort({ _id: 1 }).lean();
    const idsVistos = new Set();
    for (const u of usuarios) {
      if (u.id != null && idsVistos.has(u.id)) {
        const novoId = await nextId(Usuario);
        await Usuario.updateOne({ _id: u._id }, { $set: { id: novoId } });
        console.log(`🔧 ID duplicado corrigido: ${u.login} ${u.id} → ${novoId}`);
      } else if (u.id != null) {
        idsVistos.add(u.id);
      }
    }
  } catch (e) {
    console.warn('⚠️  repararIdsUsuarios:', e.message);
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

// Remove pontuação de CPF para normalizar o login (ex: 111.111.111-93 → 11111111193)
function normLogin(s) { return s.replace(/[\.\-\/]/g, '').toLowerCase().trim(); }

app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { login, senha } = req.body;
    if (!login || !senha) return res.status(400).json({ erro: 'Login e senha obrigatórios' });

    const loginNorm = normLogin(login);

    const bloqueio = await FailedLogin.findById(loginNorm).lean();
    if (bloqueio?.bloqueadoAte && new Date() < new Date(bloqueio.bloqueadoAte)) {
      const mins = Math.ceil((new Date(bloqueio.bloqueadoAte) - new Date()) / 60000);
      return res.status(429).json({ erro: `Conta bloqueada. Aguarde ${mins} minuto(s).` });
    }

    const u = await Usuario.findOne({ login: loginNorm }).lean();
    if (!u || !(await bcrypt.compare(senha, u.senha))) {
      await FailedLogin.findByIdAndUpdate(
        loginNorm,
        { $inc: { count: 1 }, $set: { bloqueadoAte: null } },
        { upsert: true }
      );
      const fl = await FailedLogin.findById(loginNorm).lean();
      if (fl && fl.count >= 5) {
        await FailedLogin.findByIdAndUpdate(loginNorm, { bloqueadoAte: new Date(Date.now() + 15 * 60 * 1000) });
        return res.status(429).json({ erro: 'Muitas tentativas. Conta bloqueada por 15 minutos.' });
      }
      return res.status(401).json({ erro: 'CPF ou senha incorretos' });
    }

    await FailedLogin.deleteOne({ _id: loginNorm });
    req.session.usuario = { id: u.id, login: u.login, nome: u.nome, perfil: u.perfil, cor: u.cor, matricula: u.matricula || '', cpf: u.cpf || '', secretaria: u.secretaria || '', setor: u.setor || '' };
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
    const perfil = req.session.usuario.perfil;
    const query  = perfil === 'servidor' ? { criado_por: req.session.usuario.nome } : {};
    const pcdps  = await Pcdp.find(query).sort({ id: -1 }).lean();
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
    const id    = parseInt(req.params.id);
    const perfil = req.session.usuario.perfil;

    // Servidor só pode editar as próprias PCDPs em Rascunho
    if (perfil === 'servidor') {
      const existing = await Pcdp.findOne({ id }).lean();
      if (!existing) return res.status(404).json({ erro: 'PCDP não encontrada' });
      if (existing.criado_por !== req.session.usuario.nome)
        return res.status(403).json({ erro: 'Você só pode editar suas próprias PCDPs' });
      if (existing.status !== 'Rascunho')
        return res.status(403).json({ erro: 'Só é possível editar PCDPs em Rascunho' });
    }

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

    const STATUS_VALIDOS = [
      'Rascunho','Solicitado','Passagem Reservada','Viagem Aprovada',
      'Rejeitado','Bilhete Emitido','Diárias Pagas',
      'Prestando Contas','Prestação Aprovada','Cancelado',
    ];
    if (!STATUS_VALIDOS.includes(status)) return res.status(400).json({ erro: 'Status inválido' });

    // ── Controle de acesso por perfil ─────────────────────────
    const perfil = req.session.usuario.perfil;
    const TRANSICOES = {
      'Solicitado':         ['servidor', 'secretaria', 'admin'],   // Solicitar Viagem
      'Passagem Reservada': ['secretaria', 'admin'],               // Reservar Passagem
      'Viagem Aprovada':    ['autorizador', 'admin'],              // Aprovar Viagem
      'Rejeitado':          ['autorizador', 'admin'],              // Rejeitar
      'Bilhete Emitido':    ['secretaria', 'admin'],               // Emitir Bilhete
      'Diárias Pagas':      ['secretaria', 'admin'],               // Pagar Diárias
      'Prestando Contas':   ['servidor', 'secretaria', 'admin'],   // Prestar Contas
      'Prestação Aprovada': ['autorizador', 'admin'],              // Aprovar Prestação
      'Cancelado':          ['secretaria', 'autorizador', 'admin'],
      'Rascunho':           ['servidor', 'admin'],
    };
    if (TRANSICOES[status] && !TRANSICOES[status].includes(perfil))
      return res.status(403).json({ erro: `Seu perfil não tem permissão para esta ação.` });

    // Servidor só pode alterar as próprias PCDPs
    if (perfil === 'servidor') {
      const pcdpCheck = await Pcdp.findOne({ id }).lean();
      if (pcdpCheck?.criado_por !== req.session.usuario.nome)
        return res.status(403).json({ erro: 'Você só pode alterar suas próprias PCDPs' });
    }

    const upd = { status, atualizado_em: agora() };
    if (motivo_rejeicao) upd.motivo_rejeicao = motivo_rejeicao;
    if (autorizado_por) {
      upd.autorizado_por = autorizado_por;
      upd.data_autorizacao = agora();
    }

    const pcdp = await Pcdp.findOneAndUpdate({ id }, { $set: upd }, { new: true }).lean();
    if (!pcdp) return res.status(404).json({ erro: 'PCDP não encontrada' });

    // Se mudou para "Prestando Contas", cria/garante prestação vinculada
    if (status === 'Prestando Contas') {
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

    // Se aprovada, marca a PCDP como Prestação Aprovada (etapa final)
    if (status === 'Aprovada') {
      await Pcdp.findOneAndUpdate({ id: prest.pcdp_id }, { $set: { status: 'Prestação Aprovada', atualizado_em: agora() } });
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
    const perfil     = req.session.usuario.perfil;
    const isServidor = perfil === 'servidor';
    const pcdpQuery  = isServidor ? { criado_por: req.session.usuario.nome } : {};
    const [pcdps, prestacoes, setores] = await Promise.all([
      Pcdp.find(pcdpQuery).lean(),
      isServidor ? Promise.resolve([]) : Prestacao.find({}).lean(),
      getSetores(),
    ]);

    // KPIs — novo fluxo de 7 etapas
    const total       = pcdps.length;
    const rascunho    = pcdps.filter(p => p.status === 'Rascunho').length;
    const solicitado  = pcdps.filter(p => p.status === 'Solicitado').length;
    const reservado   = pcdps.filter(p => p.status === 'Passagem Reservada').length;
    const vg_aprov    = pcdps.filter(p => p.status === 'Viagem Aprovada').length;
    const rejeitado   = pcdps.filter(p => p.status === 'Rejeitado').length;
    const bilhete     = pcdps.filter(p => p.status === 'Bilhete Emitido').length;
    const diarias_pg  = pcdps.filter(p => p.status === 'Diárias Pagas').length;
    const prestando   = pcdps.filter(p => p.status === 'Prestando Contas').length;
    const pc_aprov    = pcdps.filter(p => p.status === 'Prestação Aprovada').length;
    const cancelado   = pcdps.filter(p => p.status === 'Cancelado').length;

    // KPIs financeiros
    const total_diarias   = pcdps.reduce((s, p) => s + (p.valor_diarias || 0), 0);
    const total_passagens = pcdps.reduce((s, p) => s + (p.valor_passagens || 0), 0);
    const total_valor     = pcdps.reduce((s, p) => s + (p.valor_total || 0), 0);

    // Prestações
    const prest_pendentes  = prestacoes.filter(p => p.status === 'Pendente').length;
    const prest_analise    = prestacoes.filter(p => p.status === 'Em análise').length;
    const prest_aprovadas  = prestacoes.filter(p => p.status === 'Aprovada').length;
    const prest_pendencias = prestacoes.filter(p => p.status === 'Com pendências').length;

    // PCDPs por status (para gráfico)
    const por_status = [
      { status: 'Rascunho',          qtd: rascunho,   cor: '#94a3b8' },
      { status: 'Solicitado',        qtd: solicitado, cor: '#f59e0b' },
      { status: 'Pass. Reservada',   qtd: reservado,  cor: '#3b82f6' },
      { status: 'Viagem Aprovada',   qtd: vg_aprov,   cor: '#10b981' },
      { status: 'Bilhete Emitido',   qtd: bilhete,    cor: '#06b6d4' },
      { status: 'Diárias Pagas',     qtd: diarias_pg, cor: '#8b5cf6' },
      { status: 'Prestando Contas',  qtd: prestando,  cor: '#f97316' },
      { status: 'Prest. Aprovada',   qtd: pc_aprov,   cor: '#059669' },
      { status: 'Rejeitado',         qtd: rejeitado,  cor: '#ef4444' },
      { status: 'Cancelado',         qtd: cancelado,  cor: '#6b7280' },
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
        total, rascunho, solicitado, reservado, vg_aprov,
        rejeitado, bilhete, diarias_pg, prestando, pc_aprov, cancelado,
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
      Pcdp.find({ status: { $in: ['Solicitado','Passagem Reservada','Viagem Aprovada','Bilhete Emitido','Diárias Pagas','Prestando Contas'] } }).lean(),
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

    // PCDPs aguardando ação de secretaria ou autorizador
    const ETAPAS_LABEL = {
      'Solicitado':        'Aguardando Reserva de Passagem',
      'Passagem Reservada':'Aguardando Aprovação de Viagem',
      'Viagem Aprovada':   'Aguardando Emissão de Bilhete',
      'Bilhete Emitido':   'Aguardando Pagamento de Diárias',
      'Diárias Pagas':     'Aguardando Prestação de Contas',
      'Prestando Contas':  'Aguardando Aprovação da Prestação',
    };
    pcdps.filter(p => ETAPAS_LABEL[p.status]).forEach(p => {
      itens.push({
        tipo: 'etapa',
        id: p.id,
        numero: p.numero,
        titulo: `${ETAPAS_LABEL[p.status]} — ${p.servidor}`,
        detalhe: `Destino: ${p.destino || '—'} · ${p.data_saida || '—'} → ${p.data_retorno || '—'}`,
        dias: diasEntre(p.data_saida),
        status: p.status,
      });
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
//  ROTAS — SOLICITAÇÕES DE ACESSO (público)
// ════════════════════════════════════════════════════════════
app.get('/api/public/setores', async (req, res) => {
  try { res.json(await getSetores()); } catch (e) { res.json([]); }
});

app.get('/api/public/secretarias', async (req, res) => {
  try { res.json(await getSecretarias()); } catch (e) { res.json([]); }
});

app.post('/api/public/solicitar-acesso', async (req, res) => {
  try {
    const { nome, matricula, cpf, secretaria, setor, justificativa, perfil } = req.body;
    if (!nome)       return res.status(400).json({ erro: 'Nome é obrigatório' });
    if (!cpf)        return res.status(400).json({ erro: 'CPF é obrigatório' });
    if (!matricula)  return res.status(400).json({ erro: 'Matrícula é obrigatória' });
    if (!secretaria) return res.status(400).json({ erro: 'Secretaria é obrigatória' });
    if (!setor)      return res.status(400).json({ erro: 'Setor é obrigatório' });
    // CPF normalizado (só dígitos) é o login do usuário
    const loginNorm = cpf.replace(/\D/g, '');
    if (loginNorm.length !== 11) return res.status(400).json({ erro: 'CPF inválido — informe os 11 dígitos' });
    const jaExiste = await Usuario.findOne({ login: loginNorm }).lean();
    if (jaExiste) return res.status(409).json({ erro: 'Este CPF já possui acesso ao sistema' });
    const jaSolicitou = await Solicitacao.findOne({ login: loginNorm, status: 'Pendente' }).lean();
    if (jaSolicitou) return res.status(409).json({ erro: 'Já existe uma solicitação pendente para este CPF' });
    const id = await nextId(Solicitacao);
    await Solicitacao.create({
      id, nome: nome.trim(), login: loginNorm,
      matricula: matricula.trim(),
      cpf: cpf.trim(),
      secretaria: secretaria.trim(),
      setor: setor.trim(),
      justificativa: justificativa?.trim() || '',
      perfil: perfil || 'servidor',
      status: 'Pendente',
      criado_em: agora(),
    });
    res.status(201).json({ ok: true });
  } catch (e) { res.status(500).json({ erro: 'Erro ao registrar solicitação' }); }
});

app.get('/api/solicitacoes', admin, async (req, res) => {
  try {
    const lista = await Solicitacao.find({}).sort({ id: -1 }).lean();
    res.json(lista);
  } catch (e) { res.status(500).json({ erro: 'Erro ao buscar solicitações' }); }
});

app.patch('/api/solicitacoes/:id/aprovar', admin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const s = await Solicitacao.findOne({ id }).lean();
    if (!s) return res.status(404).json({ erro: 'Solicitação não encontrada' });
    if (s.status !== 'Pendente') return res.status(400).json({ erro: 'Solicitação já foi resolvida' });
    const jaExiste = await Usuario.findOne({ login: s.login }).lean();
    if (jaExiste) {
      await Solicitacao.updateOne({ id }, { $set: { status: 'Rejeitada', resolvido_em: agora(), resolvido_por: req.session.usuario.nome } });
      return res.status(409).json({ erro: 'Login já existe. Solicitação rejeitada automaticamente.' });
    }
    const cores = ['#2563eb','#7c3aed','#059669','#d97706','#dc2626','#0891b2','#be185d','#65a30d'];
    const total = await Usuario.countDocuments();
    const senhaHash = await bcrypt.hash('1234', 10);
    const uid = await nextId(Usuario);
    await Usuario.create({
      id: uid, login: s.login, senha: senhaHash,
      nome: s.nome, perfil: s.perfil || 'servidor',
      matricula: s.matricula || s.login,
      cpf: s.cpf || '',
      secretaria: s.secretaria || '',
      setor: s.setor || '', cor: cores[total % cores.length],
    });
    await Solicitacao.updateOne({ id }, { $set: { status: 'Aprovada', resolvido_em: agora(), resolvido_por: req.session.usuario.nome } });
    await registrarLog(req, 'usuario', 'criar', `Solicitação de ${s.login} aprovada → usuário criado (senha padrão)`);
    res.json({ ok: true, senha_padrao: '1234' });
  } catch (e) { res.status(500).json({ erro: 'Erro ao aprovar solicitação' }); }
});

app.patch('/api/solicitacoes/:id/rejeitar', admin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await Solicitacao.updateOne({ id }, { $set: { status: 'Rejeitada', resolvido_em: agora(), resolvido_por: req.session.usuario.nome } });
    await registrarLog(req, 'usuario', 'rejeitar', `Solicitação id=${id} rejeitada`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: 'Erro ao rejeitar solicitação' }); }
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
//  ROTAS — SECRETARIAS
// ════════════════════════════════════════════════════════════
app.get('/api/secretarias', auth, async (req, res) => {
  res.json(await getSecretarias());
});

app.post('/api/secretarias', admin, async (req, res) => {
  try {
    const { secretarias } = req.body;
    if (!Array.isArray(secretarias)) return res.status(400).json({ erro: 'secretarias deve ser array' });
    await Config.updateOne({ chave: 'secretarias' }, { valor: secretarias.map(s => s.trim()).filter(Boolean) }, { upsert: true });
    await registrarLog(req, 'config', 'secretarias', 'Secretarias atualizadas');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: 'Erro ao salvar secretarias' }); }
});

// ════════════════════════════════════════════════════════════
//  ROTAS — AEROPORTOS (proxy + lista BR)
// ════════════════════════════════════════════════════════════
const AEROPORTOS_BR = [
  // Rio de Janeiro
  { iata:'GIG', icao:'SBGL', nome:'Aeroporto Internacional do Galeão — Tom Jobim', cidade:'Rio de Janeiro', uf:'RJ' },
  { iata:'SDU', icao:'SBRJ', nome:'Aeroporto Santos Dumont', cidade:'Rio de Janeiro', uf:'RJ' },
  // São Paulo
  { iata:'GRU', icao:'SBGR', nome:'Aeroporto Internacional de Guarulhos', cidade:'São Paulo', uf:'SP' },
  { iata:'CGH', icao:'SBSP', nome:'Aeroporto de Congonhas', cidade:'São Paulo', uf:'SP' },
  { iata:'VCP', icao:'SBKP', nome:'Aeroporto Internacional de Viracopos', cidade:'Campinas', uf:'SP' },
  // Brasília
  { iata:'BSB', icao:'SBBR', nome:'Aeroporto Internacional de Brasília — Presidente JK', cidade:'Brasília', uf:'DF' },
  // Nordeste
  { iata:'SSA', icao:'SBSV', nome:'Aeroporto Internacional de Salvador — Deputado Luís Eduardo', cidade:'Salvador', uf:'BA' },
  { iata:'FOR', icao:'SBFZ', nome:'Aeroporto Internacional de Fortaleza — Pinto Martins', cidade:'Fortaleza', uf:'CE' },
  { iata:'REC', icao:'SBRF', nome:'Aeroporto Internacional do Recife — Guararapes', cidade:'Recife', uf:'PE' },
  { iata:'NAT', icao:'SBSG', nome:'Aeroporto Internacional de Natal — São Gonçalo do Amarante', cidade:'Natal', uf:'RN' },
  { iata:'MCZ', icao:'SBMO', nome:'Aeroporto Internacional de Maceió — Zumbi dos Palmares', cidade:'Maceió', uf:'AL' },
  { iata:'JPA', icao:'SBJP', nome:'Aeroporto Internacional de João Pessoa — Castro Pinto', cidade:'João Pessoa', uf:'PB' },
  { iata:'THE', icao:'SBTE', nome:'Aeroporto Internacional de Teresina — Senador Petrônio Portella', cidade:'Teresina', uf:'PI' },
  { iata:'SLZ', icao:'SBSL', nome:'Aeroporto Internacional de São Luís — Marechal Cunha Machado', cidade:'São Luís', uf:'MA' },
  { iata:'AJU', icao:'SBAR', nome:'Aeroporto Internacional de Aracaju — Santa Maria', cidade:'Aracaju', uf:'SE' },
  // Sul
  { iata:'POA', icao:'SBPA', nome:'Aeroporto Internacional de Porto Alegre — Salgado Filho', cidade:'Porto Alegre', uf:'RS' },
  { iata:'CWB', icao:'SBCT', nome:'Aeroporto Internacional de Curitiba — Afonso Pena', cidade:'Curitiba', uf:'PR' },
  { iata:'FLN', icao:'SBFL', nome:'Aeroporto Internacional de Florianópolis — Hercílio Luz', cidade:'Florianópolis', uf:'SC' },
  { iata:'IGU', icao:'SBFI', nome:'Aeroporto Internacional de Foz do Iguaçu — Cataratas', cidade:'Foz do Iguaçu', uf:'PR' },
  { iata:'LDB', icao:'SBLO', nome:'Aeroporto de Londrina — Governador José Richa', cidade:'Londrina', uf:'PR' },
  { iata:'MGF', icao:'SBMG', nome:'Aeroporto Regional de Maringá — Silvio Name Júnior', cidade:'Maringá', uf:'PR' },
  // Sudeste
  { iata:'CNF', icao:'SBCF', nome:'Aeroporto Internacional de Belo Horizonte — Confins', cidade:'Belo Horizonte', uf:'MG' },
  { iata:'PLU', icao:'SBBH', nome:'Aeroporto da Pampulha — Carlos Drummond de Andrade', cidade:'Belo Horizonte', uf:'MG' },
  { iata:'VIX', icao:'SBVT', nome:'Aeroporto Internacional de Vitória — Eurico de Aguiar Salles', cidade:'Vitória', uf:'ES' },
  { iata:'UDI', icao:'SBUL', nome:'Aeroporto Internacional de Uberlândia — Ten. Cel. Av. César Bombonato', cidade:'Uberlândia', uf:'MG' },
  // Norte
  { iata:'MAO', icao:'SBEG', nome:'Aeroporto Internacional de Manaus — Eduardo Gomes', cidade:'Manaus', uf:'AM' },
  { iata:'BEL', icao:'SBBE', nome:'Aeroporto Internacional de Belém — Val de Cans', cidade:'Belém', uf:'PA' },
  { iata:'MCP', icao:'SBMQ', nome:'Aeroporto Internacional de Macapá — Alberto Alcolumbre', cidade:'Macapá', uf:'AP' },
  { iata:'PVH', icao:'SBPV', nome:'Aeroporto Internacional de Porto Velho — Governador Jorge Teixeira', cidade:'Porto Velho', uf:'RO' },
  { iata:'BVB', icao:'SBBV', nome:'Aeroporto Internacional de Boa Vista — Atlas Brasil Cantanhede', cidade:'Boa Vista', uf:'RR' },
  { iata:'RBR', icao:'SBRB', nome:'Aeroporto Internacional de Rio Branco — Plácido de Castro', cidade:'Rio Branco', uf:'AC' },
  { iata:'PMW', icao:'SBPJ', nome:'Aeroporto de Palmas — Brigadeiro Lysias Rodrigues', cidade:'Palmas', uf:'TO' },
  { iata:'STM', icao:'SBSN', nome:'Aeroporto Internacional de Santarém — Maestro Wilson Fonseca', cidade:'Santarém', uf:'PA' },
  // Centro-Oeste
  { iata:'CGR', icao:'SBCG', nome:'Aeroporto Internacional de Campo Grande', cidade:'Campo Grande', uf:'MS' },
  { iata:'CGB', icao:'SBCY', nome:'Aeroporto Internacional de Cuiabá — Marechal Rondon', cidade:'Cuiabá', uf:'MT' },
  { iata:'GYN', icao:'SBGO', nome:'Aeroporto Internacional de Goiânia — Santa Genoveva', cidade:'Goiânia', uf:'GO' },
  // Outros destinos relevantes
  { iata:'BPS', icao:'SBBP', nome:'Aeroporto de Porto Seguro', cidade:'Porto Seguro', uf:'BA' },
  { iata:'IOS', icao:'SBIL', nome:'Aeroporto Jorge Amado — Ilhéus', cidade:'Ilhéus', uf:'BA' },
  { iata:'MNX', icao:'SBMY', nome:'Aeroporto de Manicoré', cidade:'Manicoré', uf:'AM' },
];

const AEROPORTOS_INT = [
  // Portugal
  { iata:'LIS', icao:'LPPT', nome:'Aeroporto Humberto Delgado', cidade:'Lisboa', pais:'Portugal' },
  { iata:'OPO', icao:'LPPR', nome:'Aeroporto Francisco Sá Carneiro', cidade:'Porto', pais:'Portugal' },
  { iata:'FAO', icao:'LPFR', nome:'Aeroporto Internacional de Faro', cidade:'Faro', pais:'Portugal' },
  // Argentina
  { iata:'EZE', icao:'SAEZ', nome:'Aeroporto Internacional Ministro Pistarini — Ezeiza', cidade:'Buenos Aires', pais:'Argentina' },
  { iata:'AEP', icao:'SABE', nome:'Aeroporto Jorge Newbery — Aeroparque', cidade:'Buenos Aires', pais:'Argentina' },
  { iata:'COR', icao:'SACO', nome:'Aeroporto Internacional Ambrosio Taravella', cidade:'Córdoba', pais:'Argentina' },
  // EUA
  { iata:'MIA', icao:'KMIA', nome:'Aeroporto Internacional de Miami', cidade:'Miami', pais:'Estados Unidos' },
  { iata:'JFK', icao:'KJFK', nome:'Aeroporto Internacional John F. Kennedy', cidade:'Nova York', pais:'Estados Unidos' },
  { iata:'GRU', icao:'KGRU', nome:'Aeroporto Internacional de Guarulhos', cidade:'São Paulo', pais:'Brasil' },
  { iata:'LAX', icao:'KLAX', nome:'Aeroporto Internacional de Los Angeles', cidade:'Los Angeles', pais:'Estados Unidos' },
  { iata:'ORD', icao:'KORD', nome:'Aeroporto Internacional O\'Hare', cidade:'Chicago', pais:'Estados Unidos' },
  { iata:'IAD', icao:'KIAD', nome:'Aeroporto Internacional Washington Dulles', cidade:'Washington', pais:'Estados Unidos' },
  // França
  { iata:'CDG', icao:'LFPG', nome:'Aeroporto Internacional Charles de Gaulle', cidade:'Paris', pais:'França' },
  { iata:'ORY', icao:'LFPO', nome:'Aeroporto de Orly', cidade:'Paris', pais:'França' },
  // Espanha
  { iata:'MAD', icao:'LEMD', nome:'Aeroporto Internacional Adolfo Suárez Madrid-Barajas', cidade:'Madrid', pais:'Espanha' },
  { iata:'BCN', icao:'LEBL', nome:'Aeroporto Internacional El Prat', cidade:'Barcelona', pais:'Espanha' },
  // Itália
  { iata:'FCO', icao:'LIRF', nome:'Aeroporto Internacional Leonardo da Vinci — Fiumicino', cidade:'Roma', pais:'Itália' },
  { iata:'MXP', icao:'LIMC', nome:'Aeroporto Internacional de Milão Malpensa', cidade:'Milão', pais:'Itália' },
  // Alemanha
  { iata:'FRA', icao:'EDDF', nome:'Aeroporto Internacional de Frankfurt', cidade:'Frankfurt', pais:'Alemanha' },
  { iata:'MUC', icao:'EDDM', nome:'Aeroporto Internacional Franz Josef Strauss', cidade:'Munique', pais:'Alemanha' },
  // Reino Unido
  { iata:'LHR', icao:'EGLL', nome:'Aeroporto Internacional de Heathrow', cidade:'Londres', pais:'Reino Unido' },
  { iata:'LGW', icao:'EGKK', nome:'Aeroporto de Gatwick', cidade:'Londres', pais:'Reino Unido' },
  // Holanda
  { iata:'AMS', icao:'EHAM', nome:'Aeroporto Internacional de Amsterdã Schiphol', cidade:'Amsterdã', pais:'Holanda' },
  // Suíça
  { iata:'ZRH', icao:'LSZH', nome:'Aeroporto Internacional de Zurique', cidade:'Zurique', pais:'Suíça' },
  // Bélgica
  { iata:'BRU', icao:'EBBR', nome:'Aeroporto Internacional de Bruxelas', cidade:'Bruxelas', pais:'Bélgica' },
  // Japão
  { iata:'NRT', icao:'RJAA', nome:'Aeroporto Internacional Narita', cidade:'Tóquio', pais:'Japão' },
  { iata:'HND', icao:'RJTT', nome:'Aeroporto Internacional Haneda', cidade:'Tóquio', pais:'Japão' },
  // China
  { iata:'PEK', icao:'ZBAA', nome:'Aeroporto Internacional de Pequim — Capital', cidade:'Pequim', pais:'China' },
  { iata:'PVG', icao:'ZSPD', nome:'Aeroporto Internacional de Xangai Pudong', cidade:'Xangai', pais:'China' },
  // Emirados
  { iata:'DXB', icao:'OMDB', nome:'Aeroporto Internacional de Dubai', cidade:'Dubai', pais:'Emirados Árabes Unidos' },
  // México
  { iata:'MEX', icao:'MMMX', nome:'Aeroporto Internacional Benito Juárez', cidade:'Cidade do México', pais:'México' },
  // Chile
  { iata:'SCL', icao:'SCEL', nome:'Aeroporto Internacional Comodoro Arturo Merino Benítez', cidade:'Santiago', pais:'Chile' },
  // Colômbia
  { iata:'BOG', icao:'SKBO', nome:'Aeroporto Internacional El Dorado', cidade:'Bogotá', pais:'Colômbia' },
  // Peru
  { iata:'LIM', icao:'SPJC', nome:'Aeroporto Internacional Jorge Chávez', cidade:'Lima', pais:'Peru' },
  // Uruguai
  { iata:'MVD', icao:'SUMU', nome:'Aeroporto Internacional de Carrasco', cidade:'Montevidéu', pais:'Uruguai' },
  // Paraguai
  { iata:'ASU', icao:'SGAS', nome:'Aeroporto Internacional Silvio Pettirossi', cidade:'Assunção', pais:'Paraguai' },
  // Bolívia
  { iata:'VVI', icao:'SLVR', nome:'Aeroporto Internacional Viru Viru', cidade:'Santa Cruz de la Sierra', pais:'Bolívia' },
  // Canadá
  { iata:'YYZ', icao:'CYYZ', nome:'Aeroporto Internacional Pearson', cidade:'Toronto', pais:'Canadá' },
  { iata:'YUL', icao:'CYUL', nome:'Aeroporto Internacional Pierre Elliott Trudeau', cidade:'Montreal', pais:'Canadá' },
  // Africa do Sul
  { iata:'JNB', icao:'FAOR', nome:'Aeroporto Internacional O.R. Tambo', cidade:'Joanesburgo', pais:'África do Sul' },
  // Angola
  { iata:'LAD', icao:'FNLU', nome:'Aeroporto Internacional Quatro de Fevereiro', cidade:'Luanda', pais:'Angola' },
  // Moçambique
  { iata:'MPM', icao:'FQMA', nome:'Aeroporto Internacional de Maputo', cidade:'Maputo', pais:'Moçambique' },
];

const TODOS_AEROPORTOS = [
  ...AEROPORTOS_BR.map(a => ({ ...a, pais: 'Brasil' })),
  ...AEROPORTOS_INT,
];

app.get('/api/aeroportos', auth, async (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q || q.length < 2) return res.json([]);

  // Busca em todos os aeroportos (BR + internacionais)
  const resultados = TODOS_AEROPORTOS.filter(a =>
    a.iata?.toLowerCase().includes(q) ||
    a.icao?.toLowerCase().includes(q) ||
    a.nome.toLowerCase().includes(q) ||
    a.cidade.toLowerCase().includes(q) ||
    a.pais?.toLowerCase().includes(q) ||
    (a.uf && a.uf.toLowerCase() === q)
  ).slice(0, 10).map(a => {
    const local = a.uf ? `${a.cidade}, ${a.uf}` : `${a.cidade}, ${a.pais}`;
    return {
      codigo: a.iata || a.icao,
      iata: a.iata,
      icao: a.icao,
      nome: a.nome,
      cidade: a.cidade,
      uf: a.uf || '',
      pais: a.pais || '',
      label: `${a.iata || a.icao} — ${a.nome} (${local})`,
    };
  });

  // Se parece um código IATA/ICAO e não achou na lista, tenta API externa
  if (resultados.length === 0 && /^[A-Za-z]{2,4}$/.test(q.trim())) {
    try {
      const code = q.toUpperCase();
      const resp = await fetch(`https://airportsapi.com/api/airports/${code}`);
      if (resp.ok) {
        const data = await resp.json();
        const a = data?.data?.attributes;
        if (a?.name) {
          resultados.push({
            codigo: a.iata_code || a.icao_code || code,
            iata: a.iata_code,
            icao: a.icao_code,
            nome: a.name,
            cidade: '',
            label: `${a.iata_code || a.icao_code || code} — ${a.name}`,
          });
        }
      }
    } catch (_) { /* ignora falha de API externa */ }
  }

  res.json(resultados);
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
    }).then(() => repararIdsUsuarios())
    .then(() => {
      setInterval(fazerBackup, 2 * 60 * 60 * 1000);
    }).catch(err => console.error('❌ MongoDB:', err.message));
  } else {
    console.warn('⚠️  MONGODB_URI não definido — defina no .env');
  }

  server.listen(PORT, () => console.log(`🚀 SCDP rodando em http://localhost:${PORT}`));
}

module.exports = app;
