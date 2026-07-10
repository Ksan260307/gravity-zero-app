/* ==========================================================
 * GRAVITY ZERO — 3D フライトシューター
 *
 * 無重力空間での「気持ちいい慣性操作」を目指したシューティング。
 * 物理的な正確さよりも、プレイヤーが直感的に期待する手応えを
 * 優先してパラメータを調整している。
 *
 * 構成:
 *  - 慣性フライトモデル(質量・抵抗を動的に切り替える3モード)
 *  - 一斉ロックオン + 追尾レーザー(簡易的な追尾制御)
 *  - アイテムで入手するサブ武器(照射ビーム / 誘導弾 / 追尾ミサイル)
 *  - スコアに応じた難易度上昇、耐久ゲージとゲームオーバー
 *  - ブースト / ブリンク(短距離瞬間移動)
 *  - 急加速の検出に連動した集中線・視野角の揺れなどの演出
 * ========================================================== */

import * as THREE from '../lib/three.module.min.js';
import { SoundEngine } from './audio.js';

// ---------- ワールド定数 ----------
const BOUND_X = 230;          // 左右の移動限界
const BOUND_Y = 140;          // 上下の移動限界
const SPAWN_Z = -1000;        // 敵の出現位置(奥)
const DESPAWN_Z = 60;         // 敵の消滅位置(手前)
const BULLET_SPEED = 900;     // 通常弾の速度
const LASER_SPEED = 800;      // 追尾レーザーの巡航速度
const LASER_TURN_RATE = 8.0;  // 追尾レーザーの旋回の効き
const TRAIL_LEN = 15;         // 飛翔体の軌跡の記録点数
const MAX_LOCKS = 18;         // 同時ロック上限
const LOCK_CONE_COS = 0.75;   // ロック可能な前方円錐(約41度)
const BLINK_DIST = 60;        // ブリンクの移動距離
const BLINK_COOLDOWN = 0.6;   // ブリンクの再使用待ち時間(秒)

// ---------- ゲームルール定数 ----------
const PLAYER_MAX_HP = 100;    // 機体の耐久値
const COLLISION_DAMAGE = 25;  // 敵と接触したときのダメージ
const HIT_INVINCIBLE_TIME = 1.5; // 被弾直後の無敵時間(秒)
const SCORE_PER_LEVEL = 1500; // レベルが1上がるのに必要なスコア

// ---------- サブ武器定数 ----------
const BEAM_RADIUS = 11;       // 照射ビームの有効半径
const BEAM_DPS = 14;          // 照射ビームの毎秒ダメージ
const BEAM_MAX_DURATION = 5;  // 照射の連続上限(秒)。超えると自動停止する
const COMET_SPEED = 900;      // 誘導弾の速度
const MISSILE_SPEED = 650;    // 追尾ミサイルの巡航速度
const MISSILE_COUNT = 10;     // ミサイルの一斉発射数

// サブ武器の定義(アイテムで入手し、メインショットと同時に使える)
const SUB_WEAPONS = {
    halberd: { name: 'ハルバード', cooldown: 5,  cssColor: '#66ffff', color: 0x66ffff },
    comet:   { name: 'コメット',   cooldown: 1,  cssColor: '#ff66ff', color: 0xff66ff },
    missile: { name: 'ホーミングミサイル', cooldown: 10, cssColor: '#ffaa33', color: 0xffaa33 },
};
const ITEM_TYPES = ['halberd', 'comet', 'missile'];

// ---------- ボス戦定数 ----------
const BOSS_FIRST_SCORE = 2000;     // 最初のボスが出現するスコア
const BOSS_SCORE_INTERVAL = 3000;  // 撃破後、次のボスまでに必要な追加スコア
const BOSS_SHOT_SPEED = 340;       // ボス弾の速度
const BOSS_SHOT_DAMAGE = 15;       // ボス弾の基本ダメージ
const BOSS_BONUS_SCORE = 1000;     // ボス撃破ボーナス
const REPAIR_HEAL = 30;            // 修理アイテムの回復量

// ---------- キー設定 ----------
const DEFAULT_KEYS = {
    fire: 'Space', sub: 'KeyR', lock: 'KeyF',
    boost: 'KeyE', blink: 'KeyQ', mode: 'ShiftLeft', help: 'KeyH',
};
const KEY_ACTION_LABELS = {
    fire: 'ショット', sub: 'サブ武器', lock: '一斉ロックオン',
    boost: 'ブースト', blink: 'ブリンク(瞬間移動)', mode: 'モード切替', help: 'ヘルプ / 一時停止',
};
const KEYS_STORAGE = 'gravity-zero-keys';   // キー設定の保存先
const BEST_STORAGE = 'gravity-zero-best';   // ハイスコアの保存先

/** キーコードを表示用の短い名前へ変換する */
function keyLabel(code) {
    if (!code) return '---';
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    const map = {
        Space: 'SPACE', ShiftLeft: 'SHIFT左', ShiftRight: 'SHIFT右',
        ControlLeft: 'CTRL左', ControlRight: 'CTRL右', AltLeft: 'ALT左', AltRight: 'ALT右',
        ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
        Enter: 'ENTER', Tab: 'TAB', Backspace: 'BS', Escape: 'ESC',
    };
    return map[code] || code;
}

// ---------- 機体モード定義 ----------
// 「出力制限」ではなく質量そのものを変化させることで、
// 同じ入力でも手応えが変わるようにしている。
// さらにモードごとに固有の個性を持たせている:
//   damageMult   … 被弾ダメージの倍率(小さいほど頑丈)
//   fireInterval … 通常ショットの発射間隔(ms、小さいほど速射)
//   bulletDamage … 通常ショット1発の威力
//   traits       … HUDに表示する強み/弱みのラベル
const FLIGHT_MODES = [
    {
        id: 'A', name: '軽量', color: '#ff3366',
        desc: '俊敏で慣性が残らない。連射は速いが装甲が薄く、被弾に弱い。',
        mass: 0.4, drag: 0.15, force: 360,
        damageMult: 1.6, fireInterval: 70, bulletDamage: 1,
        traits: { def: '弱', fire: '速', pow: '標準' },
    },
    {
        id: 'B', name: '標準', color: '#00aaff',
        desc: '操作性・防御・火力のバランスが取れた標準状態。',
        mass: 1.0, drag: 0.05, force: 290,
        damageMult: 1.0, fireInterval: 95, bulletDamage: 1,
        traits: { def: '標準', fire: '標準', pow: '標準' },
    },
    {
        id: 'C', name: '重装', color: '#33ffaa',
        desc: '重く粘る慣性。装甲が厚く被弾に強いが、連射は遅め(一撃は重い)。',
        mass: 2.5, drag: 0.015, force: 215,
        damageMult: 0.5, fireInterval: 140, bulletDamage: 2,
        traits: { def: '強', fire: '遅', pow: '高' },
    },
];

/** 固定長オブジェクトプール:毎フレームの生成/破棄によるGC負荷を避ける */
class ObjectPool {
    constructor(createFn, size) {
        this.pool = Array.from({ length: size }, createFn);
    }
    get() {
        const item = this.pool.find(i => !i.active);
        if (item) item.active = true;
        return item;
    }
    forEachActive(callback) {
        for (let i = 0; i < this.pool.length; i++) {
            if (this.pool[i].active) callback(this.pool[i]);
        }
    }
}

// ==========================================================
// 自機
// ==========================================================
class PlayerCraft {
    constructor(game) {
        this.game = game;

        this.pos = new THREE.Vector3(0, 0, 0);
        this.vel = new THREE.Vector3(0, 0, 0);
        this.accel = new THREE.Vector2(0, 0);
        this.lastAccel = new THREE.Vector2(0, 0);

        this.visualRoll = 0;   // 横移動に応じたバンク(傾き)
        this.visualPitch = 0;  // 縦移動に応じた機首の上下

        this.isBoosting = false;
        this.blinkCooldown = 0;
        this.freezeTimer = 0;      // レーザー発射後の硬直
        this.hitInvincible = 0;    // 被弾直後の無敵時間

        // 一斉ロックオン
        this.wasLocking = false;
        this.lockRange = 0;
        this.lockedTargets = [];

        // サブ武器(アイテムで入手)
        this.subWeapon = null;     // 'halberd' | 'comet' | 'missile' | null
        this.subCooldown = 0;
        this.beamActive = false;
        this.beamTime = 0;         // 照射ビームの連続使用時間

        this.buildMesh();
    }

    /** 機体の3Dモデルを単純なプリミティブの組み合わせで構築 */
    buildMesh() {
        this.group = new THREE.Group();

        const hullMat = new THREE.MeshStandardMaterial({
            color: 0x232a3a, metalness: 0.6, roughness: 0.4, flatShading: true,
        });

        // 胴体:4角錐で角張った機体らしさを出す
        const bodyGeo = new THREE.ConeGeometry(7, 30, 4);
        bodyGeo.rotateX(-Math.PI / 2); // 先端を進行方向(-Z)へ
        const body = new THREE.Mesh(bodyGeo, hullMat);
        this.group.add(body);

        // 主翼
        const wingGeo = new THREE.BoxGeometry(44, 1.5, 14);
        const wing = new THREE.Mesh(wingGeo, hullMat);
        wing.position.set(0, -1, 6);
        this.group.add(wing);

        // 垂直尾翼
        const finGeo = new THREE.BoxGeometry(1.5, 10, 9);
        const fin = new THREE.Mesh(finGeo, hullMat);
        fin.position.set(0, 5, 9);
        this.group.add(fin);

        // アクセントライン(モード色に連動)
        this.edgeMat = new THREE.LineBasicMaterial({ color: 0x00aaff });
        [bodyGeo, wingGeo, finGeo].forEach((geo, i) => {
            const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), this.edgeMat);
            edges.position.copy([body, wing, fin][i].position);
            this.group.add(edges);
        });

        // コクピット
        this.cockpitMat = new THREE.MeshBasicMaterial({ color: 0x00aaff });
        const cockpit = new THREE.Mesh(new THREE.SphereGeometry(2.6, 8, 6), this.cockpitMat);
        cockpit.scale.set(1, 0.7, 1.8);
        cockpit.position.set(0, 2.5, -2);
        this.group.add(cockpit);

        // エンジン噴射炎
        this.flameMat = new THREE.MeshBasicMaterial({
            color: 0xff6400, transparent: true, opacity: 0.85,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const flameGeo = new THREE.ConeGeometry(3.5, 14, 8);
        flameGeo.rotateX(Math.PI / 2); // 後方(+Z)へ伸ばす
        this.flame = new THREE.Mesh(flameGeo, this.flameMat);
        this.flame.position.set(0, 0, 20);
        this.group.add(this.flame);
    }

    /** モード切替時の配色更新 */
    applyModeColor(hexColor) {
        this.edgeMat.color.set(hexColor);
        this.cockpitMat.color.set(hexColor);
    }

    removeLock(enemy) {
        const index = this.lockedTargets.indexOf(enemy);
        if (index !== -1) this.lockedTargets.splice(index, 1);
    }

    update(dt, input, mode) {
        const game = this.game;
        this.isBoosting = input.boost && this.freezeTimer <= 0;

        if (this.isBoosting) game.audio.playBoost();

        // ---------- 一斉ロックオン ----------
        if (input.lock) {
            // 押している間、前方のロック範囲を広げていく
            this.lockRange = Math.min(this.lockRange + dt * 700, 950);

            game.forEachTargetable(e => {
                if (e.locked || this.lockedTargets.length >= MAX_LOCKS) return;
                const dx = e.mesh.position.x - this.pos.x;
                const dy = e.mesh.position.y - this.pos.y;
                const dz = e.mesh.position.z - this.pos.z;
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (dist > this.lockRange || dist < 1) return;

                // 前方の円錐内にいる敵だけをロック対象にする
                const forwardDot = -dz / dist;
                if (forwardDot >= LOCK_CONE_COS) {
                    e.locked = true;
                    this.lockedTargets.push(e);
                    game.audio.playLockOn();
                }
            });
        } else if (this.wasLocking) {
            // ボタンを離した瞬間に一斉発射
            if (this.lockedTargets.length > 0) {
                game.audio.playVolley();

                this.lockedTargets.forEach(target => {
                    if (target && target.active) {
                        game.spawnHomingLaser(this.pos, this.vel, target);
                    }
                    target.locked = false;
                });

                // 発射の反動として短い硬直を入れ、メリハリをつける
                this.freezeTimer = 0.3;
                game.jerkIntensity = 1.0;
                game.triggerSpeedLines(20);
            }
            this.lockedTargets.length = 0;
            this.lockRange = 0;
        }
        this.wasLocking = input.lock;

        // ---------- 硬直 ----------
        if (this.freezeTimer > 0) {
            this.freezeTimer -= dt;
            this.vel.set(0, 0, 0);
            input.x = 0;
            input.y = 0;
            input.boost = false;
            input.blink = false;
        }

        // ---------- ブリンク(短距離瞬間移動) ----------
        if (this.blinkCooldown > 0) this.blinkCooldown -= dt;

        if (input.blink) {
            if (this.blinkCooldown <= 0 && (input.x !== 0 || input.y !== 0)) {
                game.audio.playBlink();

                // 移動経路に沿って残像を置く
                for (let i = 0; i <= 5; i++) {
                    const step = i / 5;
                    game.spawnGhost(
                        this.pos.x + input.x * BLINK_DIST * step,
                        this.pos.y + input.y * BLINK_DIST * step,
                        this.pos.z,
                        this.visualRoll
                    );
                }
                this.pos.x += input.x * BLINK_DIST;
                this.pos.y += input.y * BLINK_DIST;

                // 出口速度を与えて「勢いが乗った」感触を作る
                this.vel.x = input.x * 290;
                this.vel.y = input.y * 290;

                game.jerkIntensity = 1.0;
                game.triggerSpeedLines(40);
                this.blinkCooldown = BLINK_COOLDOWN;
            }
            input.blink = false;
        }

        // ---------- 慣性モデル(推力と速度依存の抵抗) ----------
        const force = mode.force * (this.isBoosting ? 2.5 : 1.0);
        const drag = mode.drag * (this.isBoosting ? 0.8 : 1.0);

        this.accel.x = (input.x * force) / mode.mass;
        this.accel.y = (input.y * force) / mode.mass;

        // 加速度の急変(切り返しなど)を検出して演出に反映する
        const jerkX = (this.accel.x - this.lastAccel.x) / dt;
        const jerkY = (this.accel.y - this.lastAccel.y) / dt;
        const jerkMag = Math.sqrt(jerkX * jerkX + jerkY * jerkY);
        if (jerkMag > 12000 && this.freezeTimer <= 0) {
            game.jerkIntensity = Math.min(1.0, game.jerkIntensity + 0.5);
            if (Math.random() > 0.5) game.triggerSpeedLines(8);
        }
        this.lastAccel.copy(this.accel);

        // 速度に比例する抵抗:高速では自然に頭打ちし、
        // 入力を離すと滑らかに減速する
        this.vel.x += (this.accel.x - this.vel.x * drag * 10) * dt;
        this.vel.y += (this.accel.y - this.vel.y * drag * 10) * dt;

        this.pos.x += this.vel.x * dt;
        this.pos.y += this.vel.y * dt;

        // 移動限界では軽く跳ね返して行き止まり感を和らげる
        if (this.pos.x < -BOUND_X) { this.pos.x = -BOUND_X; this.vel.x *= -0.5; }
        if (this.pos.x >  BOUND_X) { this.pos.x =  BOUND_X; this.vel.x *= -0.5; }
        if (this.pos.y < -BOUND_Y) { this.pos.y = -BOUND_Y; this.vel.y *= -0.5; }
        if (this.pos.y >  BOUND_Y) { this.pos.y =  BOUND_Y; this.vel.y *= -0.5; }

        // ---------- 姿勢(バンクとピッチ) ----------
        // 横速度に応じて自然に傾き、止まると水平に戻る
        let targetRoll = -(this.vel.x / 240) * (Math.PI / 4);
        const maxBank = Math.PI / 2.2;
        targetRoll = Math.max(-maxBank, Math.min(maxBank, targetRoll));
        this.visualRoll += (targetRoll - this.visualRoll) * Math.min(1, dt * 10);

        let targetPitch = (this.vel.y / 300) * 0.45;
        targetPitch = Math.max(-0.6, Math.min(0.6, targetPitch));
        this.visualPitch += (targetPitch - this.visualPitch) * Math.min(1, dt * 8);

        // ---------- 3Dモデルへ反映 ----------
        this.group.position.copy(this.pos);
        this.group.rotation.set(this.visualPitch, 0, this.visualRoll);

        // 被弾直後は点滅させて無敵時間を可視化する
        if (this.hitInvincible > 0) {
            this.hitInvincible -= dt;
            this.group.visible = Math.floor(this.hitInvincible * 12) % 2 === 0;
        } else {
            this.group.visible = true;
        }

        // 噴射炎:入力量とブーストに応じて伸縮させ、揺らぎを加える
        const inputMag = Math.min(1, Math.hypot(input.x, input.y));
        const thrust = 0.5 + inputMag * 0.8 + (this.isBoosting ? 1.6 : 0);
        this.flame.scale.set(1, 1, thrust * (0.85 + Math.random() * 0.3));
        this.flameMat.color.set(this.isBoosting ? 0x00c8ff : 0xff6400);
    }
}

// ==========================================================
// ゲーム本体
// ==========================================================
class Game {
    constructor() {
        this.canvas = document.getElementById('game-canvas');
        this.overlay = document.getElementById('overlay-canvas');
        this.overlayCtx = this.overlay.getContext('2d');

        this.input = { x: 0, y: 0, fire: false, modeSwitch: false, boost: false, blink: false, lock: false, sub: false };
        this.audio = new SoundEngine();

        this.state = 'playing';   // 'playing' | 'gameover'
        this.currentModeIndex = 1;
        this.score = 0;
        this.level = 1;
        this.hp = PLAYER_MAX_HP;
        this.jerkIntensity = 0;   // 直近の急加速の強さ(0〜1)
        this.shakeIntensity = 0;  // 被弾時のカメラ揺れ
        this.damageFlash = 0;     // 被弾時の画面フラッシュ
        this.killCount = 0;
        this.enemyIdCounter = 0;
        this.lastFireTime = 0;
        this.spawnTimer = 0.5;

        // ボス戦の進行管理
        this.bossTime = 0;
        this.bossFireTimer = 0;
        this.nextBossScore = BOSS_FIRST_SCORE;

        // キー設定(保存済みがあれば復元する)
        this.keyBindings = { ...DEFAULT_KEYS };
        try {
            const saved = JSON.parse(localStorage.getItem(KEYS_STORAGE) || 'null');
            if (saved) {
                Object.keys(DEFAULT_KEYS).forEach(k => { if (saved[k]) this.keyBindings[k] = saved[k]; });
            }
        } catch (e) { /* 保存データが壊れていても初期設定で続行する */ }
        this.keyCaptureAction = null; // キー割り当て待ちのアクション名

        this.setupScene();
        this.setupPools();
        this.resize();
        window.addEventListener('resize', () => this.resize());

        // タイトル画面にベストスコアを表示する
        this.refreshBestOnTitle();

        // 開始画面:最初のタップで音声を有効化してから開始する
        const startOverlay = document.getElementById('start-overlay');
        this.helpOpen = false;
        const begin = () => {
            this.audio.init();
            startOverlay.style.display = 'none';
            document.getElementById('help-btn').style.display = 'flex';
            this.setupInputs();
        };
        // 開始ボタンをタップして開始(スクロール中の誤爆を防ぐためボタンに限定)
        const startBtn = startOverlay.querySelector('.start-btn');
        startBtn.addEventListener('click', begin);
        startBtn.addEventListener('touchend', (e) => { e.preventDefault(); begin(); }, { once: true });

        // ヘルプ / 一時停止
        document.getElementById('help-btn').addEventListener('click', () => this.toggleHelp());
        document.getElementById('help-resume').addEventListener('click', () => this.closeHelp());

        // ゲームオーバー画面:タップで再スタート
        document.getElementById('gameover-overlay').addEventListener('click', () => this.reset());

        // キーコンフィグUIの構築と、キー割り当て入力の受付
        this.buildKeyConfigUI();
        this.setupKeyCapture();

        // タブが隠れたら自動で一時停止する(見ていない間の被弾を防ぐ)
        document.addEventListener('visibilitychange', () => {
            if (document.hidden && this.state === 'playing') this.openHelp();
        });

        this.updateModeUI();
        this.lastTime = performance.now();
        requestAnimationFrame(this.loop.bind(this));
    }

    // ---------- シーン構築 ----------
    setupScene() {
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x050510);
        this.scene.fog = new THREE.Fog(0x050510, 500, 1300);

        this.baseFov = 72;
        this.camera = new THREE.PerspectiveCamera(this.baseFov, 1, 0.1, 2500);
        this.camera.position.set(0, 45, 170);
        this.cameraTarget = new THREE.Vector3(0, 0, -250);

        this.scene.add(new THREE.AmbientLight(0x8899bb, 0.6));
        const sun = new THREE.DirectionalLight(0xffffff, 1.1);
        sun.position.set(120, 250, 80);
        this.scene.add(sun);

        // 自機
        this.player = new PlayerCraft(this);
        this.scene.add(this.player.group);

        // ロック範囲を示す前方の円錐(押している間だけ表示)
        const coneGeo = new THREE.ConeGeometry(Math.tan(Math.acos(LOCK_CONE_COS)), 1, 24, 1, true);
        coneGeo.translate(0, -0.5, 0);
        coneGeo.rotateX(Math.PI / 2);
        this.lockCone = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({
            color: 0x00ffff, transparent: true, opacity: 0.05,
            side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        this.lockCone.visible = false;
        this.scene.add(this.lockCone);

        // 照射ビーム(サブ武器):外側の光条と白い芯の二重構造
        this.beamGroup = new THREE.Group();
        const beamOuterGeo = new THREE.CylinderGeometry(BEAM_RADIUS, BEAM_RADIUS, 1, 16, 1, true);
        beamOuterGeo.rotateX(Math.PI / 2);
        beamOuterGeo.translate(0, 0, -0.5); // 原点から前方(-Z)へ伸びる形にする
        this.beamGroup.add(new THREE.Mesh(beamOuterGeo, new THREE.MeshBasicMaterial({
            color: SUB_WEAPONS.halberd.color, transparent: true, opacity: 0.22,
            side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
        })));
        const beamCoreGeo = new THREE.CylinderGeometry(BEAM_RADIUS * 0.42, BEAM_RADIUS * 0.42, 1, 12, 1, true);
        beamCoreGeo.rotateX(Math.PI / 2);
        beamCoreGeo.translate(0, 0, -0.5);
        this.beamGroup.add(new THREE.Mesh(beamCoreGeo, new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0.6,
            depthWrite: false, blending: THREE.AdditiveBlending,
        })));
        this.beamGroup.scale.z = 1200;
        this.beamGroup.visible = false;
        this.scene.add(this.beamGroup);

        this.buildBoss();
        this.buildStarfield();
        this.buildDebris();
        this.buildParticles();
    }

    /** 奥から手前へ流れる星:前進している感覚を作る */
    buildStarfield() {
        const COUNT = 700;
        this.starSpeeds = new Float32Array(COUNT);
        const positions = new Float32Array(COUNT * 3);
        const colors = new Float32Array(COUNT * 3);

        for (let i = 0; i < COUNT; i++) {
            const depth = Math.random();
            positions[i * 3]     = (Math.random() - 0.5) * 1400;
            positions[i * 3 + 1] = (Math.random() - 0.5) * 900;
            positions[i * 3 + 2] = Math.random() * 1600 - 1400;
            this.starSpeeds[i] = depth * 220 + 50;
            const b = 0.3 + depth * 0.7;
            colors[i * 3] = b; colors[i * 3 + 1] = b; colors[i * 3 + 2] = Math.min(1, b + 0.15);
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        this.stars = new THREE.Points(geo, new THREE.PointsMaterial({
            size: 2.2, vertexColors: true, sizeAttenuation: true,
            transparent: true, opacity: 0.9, depthWrite: false,
        }));
        this.scene.add(this.stars);
    }

    /** 漂う岩塊:視差で奥行きと速度感を補強する */
    buildDebris() {
        this.debris = [];
        const mat = new THREE.MeshStandardMaterial({
            color: 0x3a4055, metalness: 0.1, roughness: 0.9, flatShading: true,
        });
        for (let i = 0; i < 10; i++) {
            const size = Math.random() * 26 + 10;
            const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 0), mat);
            rock.position.set(
                (Math.random() - 0.5) * 1100,
                (Math.random() - 0.5) * 700,
                Math.random() * 1600 - 1400
            );
            rock.userData.spin = new THREE.Vector3(Math.random(), Math.random(), Math.random()).multiplyScalar(0.4);
            this.scene.add(rock);
            this.debris.push(rock);
        }
    }

    /** 爆発などの粒子:1つのPointsにまとめて描画負荷を抑える */
    buildParticles() {
        const CAP = 600;
        this.particleCap = CAP;
        this.particlePos = new Float32Array(CAP * 3);
        this.particleVel = new Float32Array(CAP * 3);
        this.particleLife = new Float32Array(CAP);
        this.particleMaxLife = new Float32Array(CAP);
        this.particleBaseColor = new Float32Array(CAP * 3);
        const colors = new Float32Array(CAP * 3);
        this.particlePos.fill(-99999);

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(this.particlePos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        this.particlePoints = new THREE.Points(geo, new THREE.PointsMaterial({
            size: 4, vertexColors: true, sizeAttenuation: true,
            transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        this.particlePoints.frustumCulled = false;
        this.scene.add(this.particlePoints);
        this.particleCursor = 0;
    }

    /** ボス機体:大型の多面体+回転リング。通常は非表示で待機する */
    buildBoss() {
        const group = new THREE.Group();

        const core = new THREE.Mesh(
            new THREE.IcosahedronGeometry(30, 0),
            new THREE.MeshStandardMaterial({
                color: 0x1a1020, emissive: 0xff3344, emissiveIntensity: 0.7, flatShading: true,
            })
        );
        group.add(core);

        this.bossRing = new THREE.Mesh(
            new THREE.TorusGeometry(46, 2.2, 8, 40),
            new THREE.MeshBasicMaterial({
                color: 0xff5566, transparent: true, opacity: 0.55,
                blending: THREE.AdditiveBlending, depthWrite: false,
            })
        );
        group.add(this.bossRing);

        const eye = new THREE.Mesh(
            new THREE.SphereGeometry(7, 10, 8),
            new THREE.MeshBasicMaterial({ color: 0xffee88 })
        );
        eye.position.z = 26;
        group.add(eye);

        group.visible = false;
        this.scene.add(group);

        // 敵と同じ形のオブジェクトにして、ロックオンや追尾兵器の対象にできるようにする
        this.boss = {
            active: false, id: 0, mesh: group, core,
            size: 38, hp: 0, maxHp: 1, locked: false,
            colorHex: '#ff4455', vel: new THREE.Vector3(),
        };
    }

    // ---------- オブジェクトプール ----------
    setupPools() {
        // 通常弾
        this.bulletMat = new THREE.MeshBasicMaterial({
            color: 0x00aaff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
        });
        const bulletGeo = new THREE.BoxGeometry(2.5, 2.5, 16);
        this.bullets = new ObjectPool(() => {
            const mesh = new THREE.Mesh(bulletGeo, this.bulletMat);
            mesh.visible = false;
            this.scene.add(mesh);
            return { active: false, mesh, vel: new THREE.Vector3() };
        }, 60);

        // 敵機
        const enemyGeo = new THREE.OctahedronGeometry(1, 0);
        const enemyColors = [0xff3366, 0xffaa00, 0xff00ff, 0x00ff33];
        this.enemyMats = enemyColors.map(c => new THREE.MeshStandardMaterial({
            color: 0x111118, emissive: c, emissiveIntensity: 0.7, flatShading: true,
        }));
        this.enemies = new ObjectPool(() => {
            const mesh = new THREE.Mesh(enemyGeo, this.enemyMats[0]);
            mesh.visible = false;
            this.scene.add(mesh);
            return { active: false, id: 0, mesh, vel: new THREE.Vector3(), hp: 0, size: 0, locked: false, colorHex: '#ff3366' };
        }, 40);

        // 追尾する飛翔体(軌跡ライン付き)は共通の作りでプール化する
        this.homingLasers = this.createTrailPool(60, 0x00ffff);          // 一斉ロックオンのレーザー
        this.comets = this.createTrailPool(8, SUB_WEAPONS.comet.color);  // 誘導弾
        this.missiles = this.createTrailPool(30, SUB_WEAPONS.missile.color); // 追尾ミサイル

        // アイテム(サブ武器3種+修理)
        const ringGeo = new THREE.TorusGeometry(11, 0.9, 8, 24);
        const innerGeos = {
            halberd: new THREE.BoxGeometry(9, 9, 9),
            comet: new THREE.SphereGeometry(6, 10, 8),
            missile: new THREE.ConeGeometry(6, 12, 8),
            repair: new THREE.OctahedronGeometry(7, 0),
        };
        const innerColors = {
            halberd: SUB_WEAPONS.halberd.color,
            comet: SUB_WEAPONS.comet.color,
            missile: SUB_WEAPONS.missile.color,
            repair: 0x66ff88,
        };
        this.items = new ObjectPool(() => {
            const group = new THREE.Group();
            group.add(new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
                color: 0xffffff, transparent: true, opacity: 0.7,
                blending: THREE.AdditiveBlending, depthWrite: false,
            })));
            const inners = {};
            for (const type of Object.keys(innerGeos)) {
                const m = new THREE.Mesh(innerGeos[type], new THREE.MeshBasicMaterial({
                    color: innerColors[type], transparent: true, opacity: 0.9,
                    blending: THREE.AdditiveBlending, depthWrite: false,
                }));
                m.visible = false;
                inners[type] = m;
                group.add(m);
            }
            group.visible = false;
            this.scene.add(group);
            return { active: false, group, inners, type: 'halberd', vel: new THREE.Vector3() };
        }, 6);

        // ボスの弾
        const shotGeo = new THREE.SphereGeometry(4, 8, 6);
        this.shotMat = new THREE.MeshBasicMaterial({
            color: 0xff6688, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
        });
        this.enemyShots = new ObjectPool(() => {
            const mesh = new THREE.Mesh(shotGeo, this.shotMat);
            mesh.visible = false;
            this.scene.add(mesh);
            return { active: false, mesh, vel: new THREE.Vector3() };
        }, 30);

        // ブリンクの残像
        const ghostGeo = new THREE.ConeGeometry(7, 30, 4);
        ghostGeo.rotateX(-Math.PI / 2);
        this.ghosts = new ObjectPool(() => {
            const mat = new THREE.MeshBasicMaterial({
                color: 0x00ffff, transparent: true, opacity: 0.4,
                blending: THREE.AdditiveBlending, depthWrite: false,
            });
            const mesh = new THREE.Mesh(ghostGeo, mat);
            mesh.visible = false;
            this.scene.add(mesh);
            return { active: false, mesh, life: 0 };
        }, 12);

        // 集中線(2Dオーバーレイに描く)
        this.fxLines = new ObjectPool(() => ({ active: false, angle: 0, life: 0, maxLife: 0, speed: 0 }), 60);
    }

    /** 軌跡ライン付き飛翔体のプールを作る(レーザー・誘導弾・ミサイル共通) */
    createTrailPool(size, colorNum) {
        const cssColor = '#' + new THREE.Color(colorNum).getHexString();
        return new ObjectPool(() => {
            const positions = new Float32Array((TRAIL_LEN + 1) * 3);
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
                color: colorNum, transparent: true, opacity: 0.9,
                blending: THREE.AdditiveBlending, depthWrite: false,
            }));
            line.frustumCulled = false;
            line.visible = false;
            this.scene.add(line);
            return {
                active: false, line, cssColor,
                pos: new THREE.Vector3(), vel: new THREE.Vector3(),
                target: null, targetId: 0, life: 0, damage: 2, homingDelay: 0,
                trail: new Float32Array(TRAIL_LEN * 3), trailCount: 0,
            };
        }, size);
    }

    // ---------- 入力 ----------
    setupInputs() {
        const keys = {
            KeyW: false, KeyA: false, KeyS: false, KeyD: false,
            ArrowUp: false, ArrowLeft: false, ArrowDown: false, ArrowRight: false,
        };

        const updateAxis = () => {
            // 画面上方向を正とする(Wキー・上矢印 = 上昇)
            this.input.y = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
            this.input.x = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
            const len = Math.hypot(this.input.x, this.input.y);
            if (len > 0) {
                this.input.x /= len;
                this.input.y /= len;
            }
        };

        window.addEventListener('keydown', (e) => {
            const b = this.keyBindings;
            // ヘルプ / 一時停止のトグル(停止中でも受け付ける)
            if (e.code === b.help) { this.toggleHelp(); return; }
            // 一時停止中はゲーム操作を無視する
            if (this.state === 'paused') return;
            if (Object.prototype.hasOwnProperty.call(keys, e.code)) keys[e.code] = true;
            if (e.code === b.fire) this.input.fire = true;
            if (e.code === b.lock) this.input.lock = true;
            if (e.code === b.boost) this.input.boost = true;
            if (e.code === b.blink) this.input.blink = true;
            if (e.code === b.sub) this.input.sub = true;
            // 初期設定のままなら右SHIFTでもモード切替できるようにする
            const isMode = e.code === b.mode || (b.mode === 'ShiftLeft' && e.code === 'ShiftRight');
            if (isMode) {
                if (!this.input.modeSwitch) {
                    this.switchMode();
                    this.input.modeSwitch = true;
                }
            }
            updateAxis();
        });

        window.addEventListener('keyup', (e) => {
            const b = this.keyBindings;
            if (Object.prototype.hasOwnProperty.call(keys, e.code)) keys[e.code] = false;
            if (e.code === b.fire) this.input.fire = false;
            if (e.code === b.lock) this.input.lock = false;
            if (e.code === b.boost) this.input.boost = false;
            if (e.code === b.sub) this.input.sub = false;
            if (e.code === b.mode || (b.mode === 'ShiftLeft' && e.code === 'ShiftRight')) this.input.modeSwitch = false;
            updateAxis();
        });

        // ---------- 仮想スティック(タッチ操作) ----------
        const stick = document.getElementById('virtual-stick');
        const knob = document.getElementById('stick-knob');
        let stickActive = false;
        let stickCenter = { x: 0, y: 0 };

        const updateStick = (touch) => {
            let dx = touch.clientX - stickCenter.x;
            let dy = touch.clientY - stickCenter.y;
            const maxDist = 40;
            const dist = Math.hypot(dx, dy);
            if (dist > maxDist) {
                dx = (dx / dist) * maxDist;
                dy = (dy / dist) * maxDist;
            }
            knob.style.transform = `translate(${dx}px, ${dy}px)`;
            this.input.x = dx / maxDist;
            this.input.y = -dy / maxDist; // 画面の上方向を正に変換
        };

        stick.addEventListener('touchstart', (e) => {
            e.preventDefault();
            stickActive = true;
            const rect = stick.getBoundingClientRect();
            stickCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            updateStick(e.touches[0]);
        });
        stick.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (stickActive) updateStick(e.touches[0]);
        });
        stick.addEventListener('touchend', (e) => {
            e.preventDefault();
            stickActive = false;
            knob.style.transform = 'translate(0px, 0px)';
            this.input.x = 0;
            this.input.y = 0;
        });

        const bindButton = (id, field, isTrigger = false) => {
            const btn = document.getElementById(id);
            btn.addEventListener('touchstart', (e) => { e.preventDefault(); this.input[field] = true; });
            if (!isTrigger) {
                btn.addEventListener('touchend', (e) => { e.preventDefault(); this.input[field] = false; });
            }
        };

        bindButton('btn-fire', 'fire');
        bindButton('btn-boost', 'boost');
        bindButton('btn-lock', 'lock');
        bindButton('btn-sub', 'sub');
        bindButton('btn-blink', 'blink', true);

        document.getElementById('btn-mode').addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.switchMode();
        });
    }

    switchMode() {
        this.currentModeIndex = (this.currentModeIndex + 1) % FLIGHT_MODES.length;
        this.updateModeUI();
        this.triggerSpeedLines(20);
    }

    updateModeUI() {
        const mode = FLIGHT_MODES[this.currentModeIndex];
        const nameEl = document.getElementById('mode-display');
        nameEl.innerText = mode.name;
        nameEl.style.color = mode.color;

        // モード固有の個性(防御・連射・火力)を色分けして表示する
        const rank = (label) => (label === '強' || label === '速' || label === '高') ? 'good'
            : (label === '弱' || label === '遅') ? 'bad' : 'mid';
        const setTrait = (id, label) => {
            const el = document.getElementById(id);
            el.innerText = label;
            el.className = 'trait-val trait-' + rank(label);
        };
        setTrait('trait-def', mode.traits.def);
        setTrait('trait-fire', mode.traits.fire);
        setTrait('trait-pow', mode.traits.pow);

        this.player.applyModeColor(mode.color);
        this.bulletMat.color.set(mode.color);
    }

    // ---------- スコアと難易度 ----------
    addScore(points) {
        this.score += points;
        // スコアに応じてレベルが上がり、敵の出現数・速度・耐久が増す
        this.level = 1 + Math.floor(this.score / SCORE_PER_LEVEL);
        document.getElementById('score-display').innerText = this.score;
        document.getElementById('level-display').innerText = this.level;
    }

    updateHpBar() {
        document.getElementById('hp-fill').style.width = (this.hp / PLAYER_MAX_HP * 100) + '%';
    }

    /** タイトル画面のベストスコア表示を更新する */
    refreshBestOnTitle() {
        let best = 0;
        try { best = parseInt(localStorage.getItem(BEST_STORAGE) || '0', 10) || 0; } catch (e) { /* 読めなければ0扱い */ }
        const el = document.getElementById('start-best');
        if (el) el.innerText = best;
    }

    /** 修理アイテムなどによる回復(最大値を超えない) */
    healPlayer(amount) {
        this.hp = Math.min(PLAYER_MAX_HP, this.hp + amount);
        this.updateHpBar();
    }

    damagePlayer(amount) {
        // モードごとの装甲(damageMult)で被弾ダメージを増減させる
        const dealt = amount * FLIGHT_MODES[this.currentModeIndex].damageMult;
        this.hp = Math.max(0, this.hp - dealt);
        this.updateHpBar();
        this.player.hitInvincible = HIT_INVINCIBLE_TIME;
        this.jerkIntensity = 1.0;
        this.shakeIntensity = 1.0;
        this.damageFlash = 0.7;
        this.triggerSpeedLines(10);
        this.audio.playDamage();
        if (this.hp <= 0) this.gameOver();
    }

    gameOver() {
        if (this.state === 'gameover') return;
        this.state = 'gameover';

        const p = this.player;
        p.beamActive = false;
        p.isBoosting = false;
        this.audio.stopBeam();
        this.beamGroup.visible = false;

        // ロック状態を解除
        p.lockedTargets.forEach(t => { t.locked = false; });
        p.lockedTargets.length = 0;
        p.lockRange = 0;
        this.lockCone.visible = false;

        // 撃墜演出
        this.spawnExplosion(p.pos.x, p.pos.y, p.pos.z, '#ff5533', 40);
        this.spawnExplosion(p.pos.x, p.pos.y, p.pos.z, '#ffffff', 30);
        p.group.visible = false;
        this.shakeIntensity = 1.5;
        this.damageFlash = 1.0;

        document.getElementById('final-score').innerText = this.score;
        document.getElementById('final-kills').innerText = this.killCount;

        // ハイスコアを更新して表示する
        let best = 0;
        try { best = parseInt(localStorage.getItem(BEST_STORAGE) || '0', 10) || 0; } catch (e) { /* 読めなければ0扱い */ }
        if (this.score > best) {
            best = this.score;
            try { localStorage.setItem(BEST_STORAGE, String(best)); } catch (e) { /* 保存不可でも続行 */ }
        }
        document.getElementById('best-score').innerText = best;

        document.getElementById('boss-bar-wrap').style.display = 'none';
        document.getElementById('gameover-overlay').style.display = 'flex';
        document.getElementById('help-btn').style.display = 'none';
    }

    // ---------- ヘルプ / 一時停止 ----------
    toggleHelp() {
        if (this.helpOpen) this.closeHelp();
        else this.openHelp();
    }

    openHelp() {
        // プレイ中のみ開ける(ゲームを一時停止する)
        if (this.state !== 'playing' || this.helpOpen) return;
        this.helpOpen = true;
        this.state = 'paused';

        // 一時停止中は照射音を止めておく(再開時に押し直しで復帰)
        const p = this.player;
        if (p.beamActive) {
            p.beamActive = false;
            this.beamGroup.visible = false;
            this.audio.stopBeam();
        }
        this.input.sub = false;

        // 一時停止中はBGM・効果音も止める
        if (this.audio.ctx) this.audio.ctx.suspend();

        document.getElementById('help-overlay').style.display = 'flex';
    }

    closeHelp() {
        if (!this.helpOpen) return;
        this.helpOpen = false;
        this.keyCaptureAction = null; // キー割り当て待ちのまま閉じても安全に
        this.refreshKeyConfigUI();
        document.getElementById('help-overlay').style.display = 'none';
        // ゲームオーバー直前に開いていた場合を除き、プレイに戻す
        if (this.state === 'paused') this.state = 'playing';
        if (this.audio.ctx) this.audio.ctx.resume();
        // 一時停止のあいだに溜まった経過時間を無視して滑らかに再開する
        this.lastTime = performance.now();
    }

    /** ゲームオーバー後の再スタート:全状態を初期化する */
    reset() {
        this.score = 0;
        this.level = 1;
        this.hp = PLAYER_MAX_HP;
        this.killCount = 0;
        this.enemyIdCounter = 0;
        this.jerkIntensity = 0;
        this.shakeIntensity = 0;
        this.damageFlash = 0;
        this.spawnTimer = 0.8;

        const p = this.player;
        p.pos.set(0, 0, 0);
        p.vel.set(0, 0, 0);
        p.lastAccel.set(0, 0);
        p.visualRoll = 0;
        p.visualPitch = 0;
        p.freezeTimer = 0;
        p.blinkCooldown = 0;
        p.hitInvincible = 0;
        p.wasLocking = false;
        p.lockRange = 0;
        p.lockedTargets.length = 0;
        p.subWeapon = null;
        p.subCooldown = 0;
        p.beamActive = false;
        p.beamTime = 0;
        p.group.visible = true;
        this.audio.stopBeam();

        // 全プールを初期化
        const deactivate = (pool, hide) => pool.forEachActive(o => { o.active = false; if (hide) hide(o); });
        deactivate(this.bullets, o => { o.mesh.visible = false; });
        deactivate(this.enemies, o => { o.mesh.visible = false; });
        deactivate(this.homingLasers, o => { o.line.visible = false; });
        deactivate(this.comets, o => { o.line.visible = false; });
        deactivate(this.missiles, o => { o.line.visible = false; });
        deactivate(this.ghosts, o => { o.mesh.visible = false; });
        deactivate(this.items, o => { o.group.visible = false; });
        deactivate(this.enemyShots, o => { o.mesh.visible = false; });
        deactivate(this.fxLines);

        // ボスも初期状態へ
        this.boss.active = false;
        this.boss.mesh.visible = false;
        this.boss.locked = false;
        this.nextBossScore = BOSS_FIRST_SCORE;
        document.getElementById('boss-bar-wrap').style.display = 'none';

        // 押しっぱなしの入力が持ち越されないようにする
        Object.assign(this.input, {
            x: 0, y: 0, fire: false, modeSwitch: false,
            boost: false, blink: false, lock: false, sub: false,
        });

        // 粒子も消す
        const colorAttr = this.particlePoints.geometry.attributes.color;
        this.particleLife.fill(0);
        for (let i = 0; i < this.particleCap; i++) {
            this.particlePos[i * 3 + 1] = -99999;
            colorAttr.setXYZ(i, 0, 0, 0);
        }
        this.particlePoints.geometry.attributes.position.needsUpdate = true;
        colorAttr.needsUpdate = true;

        // HUDを初期状態へ
        document.getElementById('score-display').innerText = '0';
        document.getElementById('level-display').innerText = '1';
        document.getElementById('hp-fill').style.width = '100%';
        const subName = document.getElementById('sub-name');
        subName.innerText = 'なし';
        subName.style.color = '';
        this.updateModeUI();
        document.getElementById('gameover-overlay').style.display = 'none';
        document.getElementById('help-overlay').style.display = 'none';
        document.getElementById('help-btn').style.display = 'flex';
        this.helpOpen = false;

        this.state = 'playing';
    }

    // ---------- 生成系 ----------
    triggerSpeedLines(count) {
        for (let i = 0; i < count; i++) {
            const line = this.fxLines.get();
            if (line) {
                line.angle = Math.random() * Math.PI * 2;
                line.life = 1.0;
                line.maxLife = Math.random() * 0.5 + 0.2;
                line.speed = Math.random() * 500 + 500;
            }
        }
    }

    spawnGhost(x, y, z, roll) {
        const ghost = this.ghosts.get();
        if (ghost) {
            ghost.mesh.position.set(x, y, z);
            ghost.mesh.rotation.set(0, 0, roll);
            ghost.mesh.visible = true;
            ghost.life = 1.0;
        }
    }

    /** 軌跡付き飛翔体を発射する(レーザー・誘導弾・ミサイル共通) */
    launchProjectile(pool, x, y, z, vx, vy, vz, target, homingDelay, life, damage) {
        const proj = pool.get();
        if (!proj) return null;
        proj.pos.set(x, y, z);
        proj.vel.set(vx, vy, vz);
        proj.target = target || null;
        proj.targetId = target ? target.id : -1;
        proj.homingDelay = homingDelay;
        proj.trailCount = 0;
        proj.life = life;
        proj.damage = damage;
        proj.line.visible = true;
        return proj;
    }

    spawnHomingLaser(origin, shipVel, target) {
        // まず前方の広い範囲へバラけて飛び出し、その後ターゲットへ収束する
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.random() * 1.75; // 最大約100度:横〜やや後ろにも広がる
        const initialSpeed = 500;
        this.launchProjectile(
            this.homingLasers,
            origin.x, origin.y, origin.z - 15,
            Math.sin(phi) * Math.cos(theta) * initialSpeed + shipVel.x * 0.5,
            Math.sin(phi) * Math.sin(theta) * initialSpeed + shipVel.y * 0.5,
            -Math.cos(phi) * initialSpeed,
            target, 0, 4, 2
        );
    }

    spawnItem(pos, forcedType = null) {
        const item = this.items.get();
        if (!item) return;
        // 30%で修理アイテム、それ以外はサブ武器のどれか
        item.type = forcedType || (Math.random() < 0.3
            ? 'repair'
            : ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)]);
        for (const type of Object.keys(item.inners)) {
            item.inners[type].visible = (type === item.type);
        }
        item.group.position.copy(pos);
        item.vel.set((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, 90);
        item.group.visible = true;
    }

    equipSubWeapon(type) {
        const p = this.player;
        if (p.beamActive) {
            p.beamActive = false;
            this.audio.stopBeam();
        }
        p.subWeapon = type;
        p.subCooldown = 0;
        this.addScore(300);
        this.audio.playPickup();

        const def = SUB_WEAPONS[type];
        const el = document.getElementById('sub-name');
        el.innerText = def.name;
        el.style.color = def.cssColor;
        document.getElementById('subcd-fill').style.background = def.cssColor;
    }

    spawnExplosion(x, y, z, colorHex, count = 18) {
        this.audio.playExplosion();
        const color = new THREE.Color(colorHex);
        for (let i = 0; i < count; i++) {
            const idx = this.particleCursor;
            this.particleCursor = (this.particleCursor + 1) % this.particleCap;

            this.particlePos[idx * 3] = x;
            this.particlePos[idx * 3 + 1] = y;
            this.particlePos[idx * 3 + 2] = z;

            // ランダム方向へ吹き飛ばす
            const t = Math.random() * Math.PI * 2;
            const p = Math.acos(Math.random() * 2 - 1);
            const speed = Math.random() * 130 + 40;
            this.particleVel[idx * 3]     = Math.sin(p) * Math.cos(t) * speed;
            this.particleVel[idx * 3 + 1] = Math.sin(p) * Math.sin(t) * speed;
            this.particleVel[idx * 3 + 2] = Math.cos(p) * speed;

            this.particleLife[idx] = 1.0;
            this.particleMaxLife[idx] = Math.random() * 0.4 + 0.25;

            const useWhite = Math.random() > 0.5;
            this.particleBaseColor[idx * 3]     = useWhite ? 1 : color.r;
            this.particleBaseColor[idx * 3 + 1] = useWhite ? 1 : color.g;
            this.particleBaseColor[idx * 3 + 2] = useWhite ? 1 : color.b;
        }
    }

    destroyEnemy(e, awardScore = true) {
        e.active = false;
        e.mesh.visible = false;
        if (e.locked) this.player.removeLock(e);
        this.spawnExplosion(e.mesh.position.x, e.mesh.position.y, e.mesh.position.z, e.colorHex);
        this.jerkIntensity = Math.min(1.0, this.jerkIntensity + 0.15);

        if (awardScore) {
            this.addScore(e.size > 12 ? 200 : 100);
            this.killCount++;

            // サブ武器アイテムのドロップ(未所持のときは出やすくする)
            const dropChance = this.player.subWeapon ? 0.08 : 0.25;
            if (Math.random() < dropChance) this.spawnItem(e.mesh.position);
        }
    }

    /** ロックオン・追尾兵器の対象(通常の敵+ボス)を列挙する */
    forEachTargetable(callback) {
        this.enemies.forEachActive(callback);
        if (this.boss && this.boss.active) callback(this.boss);
    }

    /** 位置posに最も近い標的を返す(zLimitより奥にいるものに限定可) */
    findNearestEnemy(pos, zLimit = Infinity) {
        let best = null;
        let bestDist = Infinity;
        this.forEachTargetable(e => {
            if (e.mesh.position.z >= zLimit) return;
            const d = e.mesh.position.distanceToSquared(pos);
            if (d < bestDist) {
                bestDist = d;
                best = e;
            }
        });
        return best;
    }

    // ---------- ボス戦 ----------
    spawnBoss() {
        const boss = this.boss;
        boss.active = true;
        boss.id = ++this.enemyIdCounter;
        boss.locked = false;
        boss.maxHp = 80 + this.level * 25; // レベルが高いほど頑丈になる
        boss.hp = boss.maxHp;
        boss.mesh.position.set(0, 0, SPAWN_Z - 150);
        boss.mesh.visible = true;
        this.bossTime = 0;
        this.bossFireTimer = 1.2;
        document.getElementById('boss-bar-wrap').style.display = 'block';
        this.updateBossBar();
        this.audio.playAlarm();
        this.triggerSpeedLines(25);
    }

    updateBossBar() {
        document.getElementById('boss-fill').style.width =
            Math.max(0, this.boss.hp / this.boss.maxHp * 100) + '%';
    }

    damageBoss(amount) {
        const boss = this.boss;
        if (!boss.active) return;
        boss.hp -= amount;
        this.updateBossBar();
        if (boss.hp <= 0) this.defeatBoss();
    }

    defeatBoss() {
        const boss = this.boss;
        boss.active = false;
        boss.mesh.visible = false;
        if (boss.locked) this.player.removeLock(boss);
        document.getElementById('boss-bar-wrap').style.display = 'none';

        // 撃破と同時に残っているボス弾も消す(理不尽な被弾を防ぐ)
        this.enemyShots.forEachActive(s => {
            this.spawnExplosion(s.mesh.position.x, s.mesh.position.y, s.mesh.position.z, '#ff6688', 5);
            s.active = false;
            s.mesh.visible = false;
        });

        // 撃破ボーナスと修理アイテムの確定ドロップ
        const pos = boss.mesh.position;
        this.spawnExplosion(pos.x, pos.y, pos.z, '#ff4455', 40);
        this.spawnExplosion(pos.x, pos.y, pos.z, '#ffffff', 30);
        this.addScore(BOSS_BONUS_SCORE);
        this.spawnItem({ x: pos.x, y: pos.y, z: pos.z }, 'repair');
        this.nextBossScore = this.score + BOSS_SCORE_INTERVAL;
        this.jerkIntensity = 1.0;
        this.shakeIntensity = 0.8;
        this.triggerSpeedLines(30);
    }

    updateBoss(dt, player) {
        const boss = this.boss;
        if (!boss.active) {
            // スコアが基準に達したらボス出現
            if (this.score >= this.nextBossScore) this.spawnBoss();
            return;
        }
        this.bossTime += dt;
        const pos = boss.mesh.position;

        // 奥から前進してきて、その後は前方でうろつきながら自機を緩く追う
        pos.z += (-450 - pos.z) * Math.min(1, dt * 0.9);
        const tx = Math.sin(this.bossTime * 0.5) * 160 + player.pos.x * 0.2;
        const ty = Math.sin(this.bossTime * 0.83) * 70 + player.pos.y * 0.15;
        pos.x += (tx - pos.x) * Math.min(1, dt * 1.2);
        pos.y += (ty - pos.y) * Math.min(1, dt * 1.2);

        boss.core.rotation.x += dt * 0.6;
        boss.core.rotation.y += dt * 0.9;
        this.bossRing.rotation.x += dt * 1.4;
        this.bossRing.rotation.z += dt * 0.8;

        // 自機を狙った3方向弾(レベルが上がるほど間隔が詰まる)
        this.bossFireTimer -= dt;
        if (this.bossFireTimer <= 0) {
            this.bossFireTimer = Math.max(0.9, 1.8 - this.level * 0.08);
            const dir = this._bossAim || (this._bossAim = new THREE.Vector3());
            dir.subVectors(player.pos, pos).normalize();
            for (let i = -1; i <= 1; i++) {
                const shot = this.enemyShots.get();
                if (!shot) break;
                shot.mesh.position.copy(pos);
                shot.vel.copy(dir).multiplyScalar(BOSS_SHOT_SPEED);
                shot.vel.x += i * 60; // 中央+左右への3方向
                shot.mesh.visible = true;
            }
        }
    }

    // ---------- キーコンフィグ ----------
    /** アクションにキーを割り当てる。他のアクションと重複したら互いのキーを入れ替える */
    setKeyBinding(action, code) {
        const b = this.keyBindings;
        for (const other of Object.keys(b)) {
            if (other !== action && b[other] === code) b[other] = b[action];
        }
        b[action] = code;
        this.saveKeyBindings();
        this.refreshKeyConfigUI();
    }

    resetKeyBindings() {
        this.keyBindings = { ...DEFAULT_KEYS };
        this.saveKeyBindings();
        this.refreshKeyConfigUI();
    }

    saveKeyBindings() {
        try {
            localStorage.setItem(KEYS_STORAGE, JSON.stringify(this.keyBindings));
        } catch (e) { /* プライベートモードなどで保存できなくても続行する */ }
    }

    /** ヘルプ画面内のキー設定UIを生成する */
    buildKeyConfigUI() {
        const wrap = document.getElementById('keyconfig-rows');
        if (!wrap) return;
        wrap.innerHTML = '';
        for (const action of Object.keys(DEFAULT_KEYS)) {
            const row = document.createElement('div');
            row.className = 'keyconfig-row';

            const label = document.createElement('span');
            label.textContent = KEY_ACTION_LABELS[action];
            row.appendChild(label);

            const btn = document.createElement('button');
            btn.className = 'key-btn';
            btn.dataset.action = action;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.keyCaptureAction = action;
                this.refreshKeyConfigUI();
            });
            row.appendChild(btn);

            wrap.appendChild(row);
        }
        const resetBtn = document.getElementById('keyconfig-reset');
        if (resetBtn) {
            resetBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.resetKeyBindings();
            });
        }
        this.refreshKeyConfigUI();
    }

    refreshKeyConfigUI() {
        document.querySelectorAll('#keyconfig-rows .key-btn').forEach(btn => {
            const action = btn.dataset.action;
            if (this.keyCaptureAction === action) {
                btn.textContent = 'キーを押してください…';
                btn.classList.add('listening');
            } else {
                btn.textContent = keyLabel(this.keyBindings[action]);
                btn.classList.remove('listening');
            }
        });
    }

    /** キー割り当て待ちの入力を最優先で受け取る(ゲーム操作より先に処理する) */
    setupKeyCapture() {
        window.addEventListener('keydown', (e) => {
            if (!this.keyCaptureAction) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.code !== 'Escape') this.setKeyBinding(this.keyCaptureAction, e.code);
            this.keyCaptureAction = null;
            this.refreshKeyConfigUI();
        }, true);
    }

    // ---------- サブ武器 ----------
    updateSubWeapon(dt) {
        const p = this.player;
        if (p.subCooldown > 0) p.subCooldown -= dt;

        const type = p.subWeapon;
        const pressed = this.input.sub && type !== null && p.freezeTimer <= 0;

        if (type === 'halberd') {
            // 押している間だけ照射する(連続5秒で自動停止)
            if (pressed && !p.beamActive && p.subCooldown <= 0) {
                p.beamActive = true;
                p.beamTime = 0;
                this.audio.startBeam();
                this.jerkIntensity = Math.min(1.0, this.jerkIntensity + 0.4);
                this.triggerSpeedLines(12);
            } else if (p.beamActive) {
                p.beamTime += dt;
                const expired = p.beamTime >= BEAM_MAX_DURATION;
                if (!pressed || expired) {
                    p.beamActive = false;
                    // クールタイムは使った時間に比例する(短く使えば早く戻る。最低1秒)
                    p.subCooldown = Math.min(
                        SUB_WEAPONS.halberd.cooldown,
                        Math.max(1, SUB_WEAPONS.halberd.cooldown * (p.beamTime / BEAM_MAX_DURATION))
                    );
                    this.audio.stopBeam();
                }
            }
        } else if (pressed && p.subCooldown <= 0) {
            if (type === 'comet') {
                // 前方で一番近い敵を追う単発の誘導弾
                const target = this.findNearestEnemy(p.pos, p.pos.z);
                this.launchProjectile(
                    this.comets,
                    p.pos.x, p.pos.y, p.pos.z - 15,
                    p.vel.x * 0.3, p.vel.y * 0.3, -COMET_SPEED,
                    target, 0, 3, 3
                );
                p.subCooldown = SUB_WEAPONS.comet.cooldown;
                this.audio.playComet();
                this.triggerSpeedLines(4);
            } else if (type === 'missile') {
                // 上下に撒いてから追尾に移る一斉ミサイル(ボスも対象)
                const targets = [];
                this.forEachTargetable(e => targets.push(e));
                targets.sort((a, b) =>
                    a.mesh.position.distanceToSquared(p.pos) - b.mesh.position.distanceToSquared(p.pos));

                for (let i = 0; i < MISSILE_COUNT; i++) {
                    const up = i % 2 === 0 ? 1 : -1; // 上下交互に打ち出す
                    this.launchProjectile(
                        this.missiles,
                        p.pos.x + (Math.random() - 0.5) * 8, p.pos.y + up * 6, p.pos.z,
                        p.vel.x * 0.3 + (Math.random() - 0.5) * 60,
                        up * (330 + Math.random() * 130),
                        -40,
                        targets.length > 0 ? targets[i % targets.length] : null,
                        0.25 + i * 0.04, // 追尾開始をずらして軌跡を散らす
                        6, 2
                    );
                }
                p.subCooldown = SUB_WEAPONS.missile.cooldown;
                this.audio.playMissileLaunch();
                this.jerkIntensity = Math.min(1.0, this.jerkIntensity + 0.4);
                this.triggerSpeedLines(15);
            }
        }

        // 照射ビームの表示更新
        this.beamGroup.visible = p.beamActive;
        if (p.beamActive) {
            this.beamGroup.position.copy(p.pos);
            this.beamGroup.position.z -= 18;
            const pulse = 0.88 + Math.random() * 0.24;
            this.beamGroup.scale.set(pulse, pulse, 1200);
        }
    }

    /** 追尾飛翔体の共通更新処理。retarget指定時は目標消失後に近くの敵へ引き継ぐ */
    updateProjectiles(pool, speed, turnRate, dt, retarget) {
        pool.forEachActive(l => {
            // 軌跡を記録(リングバッファ)
            const slot = (l.trailCount % TRAIL_LEN) * 3;
            l.trail[slot] = l.pos.x;
            l.trail[slot + 1] = l.pos.y;
            l.trail[slot + 2] = l.pos.z;
            l.trailCount++;

            if (l.homingDelay > 0) {
                // 打ち出し直後は追尾せず、慣性のまま飛ぶ
                l.homingDelay -= dt;
            } else {
                const lostTarget = !l.target || !l.target.active || l.target.id !== l.targetId;
                if (lostTarget && retarget) {
                    const next = this.findNearestEnemy(l.pos);
                    l.target = next;
                    l.targetId = next ? next.id : -1;
                }
                if (l.target && l.target.active && l.target.id === l.targetId) {
                    const tp = l.target.mesh.position;
                    const dx = tp.x - l.pos.x;
                    const dy = tp.y - l.pos.y;
                    const dz = tp.z - l.pos.z;
                    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    if (dist > 0.01) {
                        l.vel.x += ((dx / dist) * speed - l.vel.x) * turnRate * dt;
                        l.vel.y += ((dy / dist) * speed - l.vel.y) * turnRate * dt;
                        l.vel.z += ((dz / dist) * speed - l.vel.z) * turnRate * dt;
                    }
                }
            }

            // 速度の大きさを一定に保つ(曲がっても失速しない)
            const currentSpeed = l.vel.length();
            if (currentSpeed > 0) l.vel.multiplyScalar(speed / currentSpeed);

            l.pos.addScaledVector(l.vel, dt);
            l.life -= dt;

            // 軌跡ラインの頂点を更新
            const positions = l.line.geometry.attributes.position;
            const count = Math.min(l.trailCount, TRAIL_LEN);
            const startIdx = l.trailCount > TRAIL_LEN ? (l.trailCount % TRAIL_LEN) : 0;
            for (let i = 0; i < count; i++) {
                const src = ((startIdx + i) % TRAIL_LEN) * 3;
                positions.setXYZ(i, l.trail[src], l.trail[src + 1], l.trail[src + 2]);
            }
            positions.setXYZ(count, l.pos.x, l.pos.y, l.pos.z);
            l.line.geometry.setDrawRange(0, count + 1);
            positions.needsUpdate = true;

            const out = Math.abs(l.pos.x) > 1300 || Math.abs(l.pos.y) > 900 ||
                        l.pos.z < SPAWN_Z - 300 || l.pos.z > 250;
            if (out || l.life <= 0) {
                l.active = false;
                l.line.visible = false;
            }
        });
    }

    // ---------- メインループ ----------
    loop(currentTime) {
        // 同一フレームでの二重実行を防ぐ(ループが誤って複数起動しても1本に収束する)
        if (currentTime === this._lastFrameTs) return;
        this._lastFrameTs = currentTime;

        const dt = Math.min((currentTime - this.lastTime) / 1000, 0.05);
        this.lastTime = currentTime;

        // 一時停止(ヘルプ表示)中は進行を止め、画面はそのまま保つ
        if (dt > 0 && this.state !== 'paused') this.update(dt);
        this.render(dt);
        this.audio.updateBGM(currentTime);

        requestAnimationFrame(this.loop.bind(this));
    }

    update(dt) {
        const mode = FLIGHT_MODES[this.currentModeIndex];
        const player = this.player;
        const playing = this.state === 'playing';

        if (playing) player.update(dt, this.input, mode);

        // ---------- 星と岩塊のスクロール(常時) ----------
        const flowBoost = 1 + this.jerkIntensity * 2;
        const starPos = this.stars.geometry.attributes.position;
        for (let i = 0; i < this.starSpeeds.length; i++) {
            let z = starPos.getZ(i) + this.starSpeeds[i] * flowBoost * dt;
            if (z > 220) z -= 1600;
            starPos.setZ(i, z);
        }
        starPos.needsUpdate = true;

        this.debris.forEach(rock => {
            rock.position.z += 130 * flowBoost * dt;
            rock.rotation.x += rock.userData.spin.x * dt;
            rock.rotation.y += rock.userData.spin.y * dt;
            if (rock.position.z > 260) {
                rock.position.z -= 1600;
                rock.position.x = (Math.random() - 0.5) * 1100;
                rock.position.y = (Math.random() - 0.5) * 700;
            }
        });

        if (playing) {
            this.updateGameplay(dt, player);
        }

        // ---------- 粒子の更新(常時:撃墜演出のため) ----------
        const colorAttr = this.particlePoints.geometry.attributes.color;
        for (let i = 0; i < this.particleCap; i++) {
            if (this.particleLife[i] <= 0) continue;
            this.particleLife[i] -= dt / this.particleMaxLife[i];
            if (this.particleLife[i] <= 0) {
                this.particlePos[i * 3 + 1] = -99999;
                colorAttr.setXYZ(i, 0, 0, 0);
                continue;
            }
            this.particlePos[i * 3]     += this.particleVel[i * 3] * dt;
            this.particlePos[i * 3 + 1] += this.particleVel[i * 3 + 1] * dt;
            this.particlePos[i * 3 + 2] += this.particleVel[i * 3 + 2] * dt;
            const f = this.particleLife[i];
            colorAttr.setXYZ(i,
                this.particleBaseColor[i * 3] * f,
                this.particleBaseColor[i * 3 + 1] * f,
                this.particleBaseColor[i * 3 + 2] * f);
        }
        this.particlePoints.geometry.attributes.position.needsUpdate = true;
        colorAttr.needsUpdate = true;

        // ---------- 残像と集中線(常時) ----------
        this.ghosts.forEachActive(g => {
            g.life -= dt * 2.5;
            g.mesh.material.opacity = Math.max(0, g.life) * 0.4;
            if (g.life <= 0) {
                g.active = false;
                g.mesh.visible = false;
            }
        });

        this.fxLines.forEachActive(line => {
            line.life -= dt / line.maxLife;
            if (line.life <= 0) line.active = false;
        });

        // ---------- 演出値の減衰(常時) ----------
        this.jerkIntensity = Math.max(0, this.jerkIntensity - dt * 5);
        this.shakeIntensity = Math.max(0, this.shakeIntensity - dt * 3);
        this.damageFlash = Math.max(0, this.damageFlash - dt * 2);

        this.updateCamera(dt);
    }

    /** プレイ中のみ実行するゲームロジック */
    updateGameplay(dt, player) {
        const mode = FLIGHT_MODES[this.currentModeIndex];

        // ---------- 通常弾の発射(モードごとに連射間隔が変わる) ----------
        if (this.input.fire && player.freezeTimer <= 0 && performance.now() - this.lastFireTime > mode.fireInterval) {
            const bullet = this.bullets.get();
            if (bullet) {
                bullet.mesh.position.copy(player.pos);
                bullet.mesh.position.z -= 18;
                bullet.vel.set(player.vel.x * 0.2, player.vel.y * 0.2, -BULLET_SPEED);
                bullet.mesh.visible = true;
                this.lastFireTime = performance.now();
                this.audio.playShot();
            }
        }

        this.bullets.forEachActive(b => {
            b.mesh.position.addScaledVector(b.vel, dt);
            if (b.mesh.position.z < SPAWN_Z - 100) {
                b.active = false;
                b.mesh.visible = false;
            }
        });

        // ---------- サブ武器 ----------
        this.updateSubWeapon(dt);

        // ---------- 追尾する飛翔体 ----------
        this.updateProjectiles(this.homingLasers, LASER_SPEED, LASER_TURN_RATE, dt, false);
        this.updateProjectiles(this.comets, COMET_SPEED, 9.0, dt, false);
        this.updateProjectiles(this.missiles, MISSILE_SPEED, 5.5, dt, true);

        // ---------- 敵の出現(レベルが上がるほど間隔が詰まる) ----------
        this.spawnTimer -= dt;
        if (this.spawnTimer <= 0) {
            // ボス戦中は雑魚の出現を減らして、ボスに集中できるようにする
            this.spawnTimer = (Math.random() * 0.5 + 0.25) / (1 + (this.level - 1) * 0.18)
                * (this.boss.active ? 2.5 : 1);
            const enemy = this.enemies.get();
            if (enemy) {
                enemy.id = ++this.enemyIdCounter;
                enemy.size = Math.random() * 8 + 8;
                // レベルに応じて耐久を底上げする
                enemy.hp = (enemy.size > 12 ? 2 : 1) + Math.floor((this.level - 1) / 3);
                enemy.locked = false;

                enemy.mesh.position.set(
                    (Math.random() - 0.5) * 2 * (BOUND_X + 40),
                    (Math.random() - 0.5) * 2 * (BOUND_Y + 30),
                    SPAWN_Z
                );
                // レベルに応じて突入速度も上げる(上限あり)
                const speedScale = Math.min(2.4, 1 + (this.level - 1) * 0.10);
                enemy.vel.set(
                    (Math.random() - 0.5) * 50,
                    (Math.random() - 0.5) * 50,
                    (Math.random() * 120 + 150) * speedScale
                );

                const matIndex = Math.floor(Math.random() * this.enemyMats.length);
                enemy.mesh.material = this.enemyMats[matIndex];
                enemy.colorHex = '#' + this.enemyMats[matIndex].emissive.getHexString();
                enemy.mesh.scale.setScalar(enemy.size);
                enemy.mesh.visible = true;
            }
        }

        // ---------- 敵の更新と衝突判定 ----------
        const isInvincible = player.isBoosting || player.blinkCooldown > 0 ||
                             player.freezeTimer > 0 || player.hitInvincible > 0;
        const steer = Math.min(80, 28 + (this.level - 1) * 5);
        const beamRangeSq = (r) => r * r;

        this.enemies.forEachActive(e => {
            // 自機方向へ緩やかに寄せて、正面に絡む機会を増やす
            e.vel.x += Math.sign(player.pos.x - e.mesh.position.x) * steer * dt;
            e.vel.y += Math.sign(player.pos.y - e.mesh.position.y) * steer * dt;
            e.vel.x = Math.max(-90, Math.min(90, e.vel.x));
            e.vel.y = Math.max(-90, Math.min(90, e.vel.y));

            e.mesh.position.addScaledVector(e.vel, dt);
            e.mesh.rotation.x += dt * 1.2;
            e.mesh.rotation.y += dt * 0.8;

            if (e.mesh.position.z > DESPAWN_Z) {
                e.active = false;
                e.mesh.visible = false;
                if (e.locked) player.removeLock(e);
                return;
            }

            // 通常弾との衝突(モードごとに1発の威力が変わる)
            this.bullets.forEachActive(b => {
                if (!e.active || !b.active) return;
                const r = e.size + 8;
                if (b.mesh.position.distanceToSquared(e.mesh.position) < r * r) {
                    b.active = false;
                    b.mesh.visible = false;
                    e.hp -= mode.bulletDamage;
                    if (e.hp <= 0) this.destroyEnemy(e);
                }
            });

            // 追尾する飛翔体(レーザー・誘導弾・ミサイル)との衝突
            const hitProjectiles = (pool) => {
                pool.forEachActive(l => {
                    if (!e.active || !l.active) return;
                    const r = e.size + 12;
                    if (l.pos.distanceToSquared(e.mesh.position) < r * r) {
                        l.active = false;
                        l.line.visible = false;
                        e.hp -= l.damage;
                        this.spawnExplosion(l.pos.x, l.pos.y, l.pos.z, l.cssColor, 10);
                        if (e.hp <= 0) this.destroyEnemy(e);
                    }
                });
            };
            hitProjectiles(this.homingLasers);
            hitProjectiles(this.comets);
            hitProjectiles(this.missiles);

            // 照射ビームとの衝突(前方の円筒内に継続ダメージ)
            if (e.active && player.beamActive && e.mesh.position.z < player.pos.z) {
                const dx = e.mesh.position.x - player.pos.x;
                const dy = e.mesh.position.y - player.pos.y;
                if (dx * dx + dy * dy < beamRangeSq(BEAM_RADIUS + e.size)) {
                    e.hp -= BEAM_DPS * dt;
                    if (Math.random() < dt * 15) {
                        this.spawnExplosion(e.mesh.position.x, e.mesh.position.y, e.mesh.position.z, SUB_WEAPONS.halberd.cssColor, 4);
                    }
                    if (e.hp <= 0) this.destroyEnemy(e);
                }
            }

            // 自機との衝突(ブースト・ブリンク直後・硬直中・被弾直後は無敵)
            if (e.active && !isInvincible) {
                const r = e.size + 12;
                if (e.mesh.position.distanceToSquared(player.pos) < r * r) {
                    this.destroyEnemy(e, false); // 接触破壊はスコアにしない
                    this.damagePlayer(COLLISION_DAMAGE);
                }
            }
        });

        // ---------- ボスの更新と衝突 ----------
        this.updateBoss(dt, player);
        if (this.boss.active) {
            const boss = this.boss;
            const bp = boss.mesh.position;

            // 通常弾
            this.bullets.forEachActive(b => {
                if (!boss.active) return;
                const r = boss.size + 8;
                if (b.mesh.position.distanceToSquared(bp) < r * r) {
                    b.active = false;
                    b.mesh.visible = false;
                    this.damageBoss(mode.bulletDamage);
                }
            });

            // 追尾する飛翔体
            const bossHit = (pool) => pool.forEachActive(l => {
                if (!boss.active) return;
                const r = boss.size + 12;
                if (l.pos.distanceToSquared(bp) < r * r) {
                    l.active = false;
                    l.line.visible = false;
                    this.spawnExplosion(l.pos.x, l.pos.y, l.pos.z, l.cssColor, 10);
                    this.damageBoss(l.damage);
                }
            });
            bossHit(this.homingLasers);
            bossHit(this.comets);
            bossHit(this.missiles);

            // 照射ビーム
            if (boss.active && player.beamActive && bp.z < player.pos.z) {
                const dx = bp.x - player.pos.x;
                const dy = bp.y - player.pos.y;
                const rr = BEAM_RADIUS + boss.size;
                if (dx * dx + dy * dy < rr * rr) {
                    this.damageBoss(BEAM_DPS * dt);
                    if (Math.random() < dt * 12) {
                        this.spawnExplosion(bp.x, bp.y, bp.z, SUB_WEAPONS.halberd.cssColor, 4);
                    }
                }
            }
        }

        // ---------- ボス弾の更新と被弾 ----------
        this.enemyShots.forEachActive(s => {
            s.mesh.position.addScaledVector(s.vel, dt);
            const sp = s.mesh.position;
            if (sp.z > DESPAWN_Z + 40 || Math.abs(sp.x) > 900 || Math.abs(sp.y) > 700 || sp.z < SPAWN_Z - 300) {
                s.active = false;
                s.mesh.visible = false;
                return;
            }
            if (!isInvincible && sp.distanceToSquared(player.pos) < 16 * 16) {
                s.active = false;
                s.mesh.visible = false;
                this.damagePlayer(BOSS_SHOT_DAMAGE);
            }
        });

        // ---------- アイテムの更新と取得 ----------
        this.items.forEachActive(item => {
            item.group.position.addScaledVector(item.vel, dt);
            item.group.rotation.y += dt * 2.5;
            item.group.rotation.x += dt * 1.2;

            if (item.group.position.z > 100) {
                item.active = false;
                item.group.visible = false;
                return;
            }
            // 取得判定はやや甘めにして拾いやすくする
            if (item.group.position.distanceToSquared(player.pos) < 30 * 30) {
                if (item.type === 'repair') {
                    // 修理アイテム:装備は変えずに耐久を回復する
                    this.healPlayer(REPAIR_HEAL);
                    this.addScore(100);
                    this.audio.playPickup();
                } else {
                    this.equipSubWeapon(item.type);
                }
                item.active = false;
                item.group.visible = false;
            }
        });

        // ---------- ロック範囲の表示 ----------
        if (player.lockRange > 0) {
            this.lockCone.visible = true;
            this.lockCone.position.copy(player.pos);
            this.lockCone.scale.setScalar(player.lockRange);
        } else {
            this.lockCone.visible = false;
        }

        // ---------- HUDゲージの更新 ----------
        const blinkRatio = Math.max(0, Math.min(1, 1 - player.blinkCooldown / BLINK_COOLDOWN));
        document.getElementById('cooldown-fill').style.width = (blinkRatio * 100) + '%';

        let subRatio = 0;
        if (player.subWeapon) {
            // 照射中は「残り照射時間」、それ以外は「クールタイムの回復度」を示す
            subRatio = player.beamActive
                ? Math.max(0, 1 - player.beamTime / BEAM_MAX_DURATION)
                : Math.max(0, Math.min(1, 1 - player.subCooldown / SUB_WEAPONS[player.subWeapon].cooldown));
        }
        document.getElementById('subcd-fill').style.width = (subRatio * 100) + '%';
    }

    // ---------- カメラ ----------
    updateCamera(dt) {
        const p = this.player.pos;

        // 機体を少し遅れて追いかける(残る視点の慣性)
        const targetX = p.x * 0.5;
        const targetY = p.y * 0.5 + 42;
        const lerp = 1 - Math.exp(-6 * dt);
        this.camera.position.x += (targetX - this.camera.position.x) * lerp;
        this.camera.position.y += (targetY - this.camera.position.y) * lerp;
        this.camera.position.z = 170;

        // 被弾時の揺れ
        if (this.shakeIntensity > 0.01) {
            this.camera.position.x += (Math.random() - 0.5) * 14 * this.shakeIntensity;
            this.camera.position.y += (Math.random() - 0.5) * 14 * this.shakeIntensity;
        }

        // 旋回時はわずかに水平線を傾け、旋回の実感を出す
        const bankTilt = this.player.visualRoll * 0.3;
        this.camera.up.set(Math.sin(bankTilt), Math.cos(bankTilt), 0);

        this.cameraTarget.set(p.x * 0.85, p.y * 0.85, -260);
        this.camera.lookAt(this.cameraTarget);

        // 急加速・ブースト時に視野角をわずかに広げ、加速感を強調する
        const targetFov = this.baseFov + this.jerkIntensity * 10 + (this.player.isBoosting ? 6 : 0);
        this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 8);
        this.camera.updateProjectionMatrix();
    }

    // ---------- 描画 ----------
    render() {
        this.renderer.render(this.scene, this.camera);
        this.drawOverlay();
    }

    /** 照準・集中線などの2Dオーバーレイ描画 */
    drawOverlay() {
        const ctx = this.overlayCtx;
        const w = window.innerWidth;
        const h = window.innerHeight;
        ctx.clearRect(0, 0, w, h);

        // ロックオン照準:敵の3D座標を画面座標へ投影して描く
        const player = this.player;
        if (player.lockedTargets.length > 0) {
            ctx.strokeStyle = '#0ff';
            ctx.lineWidth = 2;
            const v = this._projVec || (this._projVec = new THREE.Vector3());

            player.lockedTargets.forEach(target => {
                if (!target || !target.active) return;
                v.copy(target.mesh.position).project(this.camera);
                if (v.z > 1) return; // カメラの後ろは描かない

                const sx = (v.x * 0.5 + 0.5) * w;
                const sy = (-v.y * 0.5 + 0.5) * h;
                // 距離に応じて照準サイズを変える
                const dist = target.mesh.position.distanceTo(player.pos);
                const s = Math.max(10, 1200 * target.size / Math.max(dist, 1) / 10);

                ctx.beginPath();
                ctx.moveTo(sx - s, sy - s + 6); ctx.lineTo(sx - s, sy - s); ctx.lineTo(sx - s + 6, sy - s);
                ctx.moveTo(sx + s - 6, sy - s); ctx.lineTo(sx + s, sy - s); ctx.lineTo(sx + s, sy - s + 6);
                ctx.moveTo(sx - s, sy + s - 6); ctx.lineTo(sx - s, sy + s); ctx.lineTo(sx - s + 6, sy + s);
                ctx.moveTo(sx + s - 6, sy + s); ctx.lineTo(sx + s, sy + s); ctx.lineTo(sx + s, sy + s - 6);
                ctx.stroke();
            });

            // ロック数の表示
            ctx.fillStyle = '#0ff';
            ctx.font = 'bold 14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(`LOCK ${player.lockedTargets.length}`, w / 2, h * 0.72);
        }

        // 集中線:画面中央から外へ走る線で加速の衝撃を伝える
        const cx = w / 2;
        const cy = h / 2;
        this.fxLines.forEachActive(line => {
            const dist = (1.0 - line.life) * line.speed + 100;
            const len = 100 * line.life;
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(line.angle) * dist, cy + Math.sin(line.angle) * dist);
            ctx.lineTo(cx + Math.cos(line.angle) * (dist + len), cy + Math.sin(line.angle) * (dist + len));
            ctx.strokeStyle = `rgba(255, 255, 255, ${line.life * 0.5})`;
            ctx.lineWidth = 2;
            ctx.stroke();
        });

        // 被弾時の赤いフラッシュ(画面周辺)
        if (this.damageFlash > 0.01) {
            const grad = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.3, cx, cy, Math.max(w, h) * 0.7);
            grad.addColorStop(0, 'rgba(255,0,0,0)');
            grad.addColorStop(1, `rgba(255,30,30,${this.damageFlash * 0.5})`);
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);
        }
    }

    resize() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.overlay.width = w;
        this.overlay.height = h;
    }
}

// ゲーム起動(デバッグ・テスト用にインスタンスと定数を公開)
window.addEventListener('load', () => {
    window.game = new Game();
});

// テストスイートから参照するための定数・クラスの公開
window.ZMF = {
    FLIGHT_MODES, SUB_WEAPONS, ITEM_TYPES, DEFAULT_KEYS, keyLabel,
    constants: {
        BOUND_X, BOUND_Y, SPAWN_Z, DESPAWN_Z,
        BULLET_SPEED, LASER_SPEED, MISSILE_SPEED, MISSILE_COUNT,
        PLAYER_MAX_HP, COLLISION_DAMAGE, HIT_INVINCIBLE_TIME, SCORE_PER_LEVEL,
        BEAM_RADIUS, BEAM_DPS, BEAM_MAX_DURATION, COMET_SPEED, BLINK_COOLDOWN,
        BOSS_FIRST_SCORE, BOSS_SCORE_INTERVAL, BOSS_SHOT_SPEED, BOSS_SHOT_DAMAGE,
        BOSS_BONUS_SCORE, REPAIR_HEAL,
    },
    storageKeys: { keys: KEYS_STORAGE, best: BEST_STORAGE },
};
