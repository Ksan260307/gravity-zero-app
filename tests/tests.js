/* ==========================================================
 * GRAVITY ZERO — 全網羅テストスイート
 *
 * ゲーム本体(main.js)を実際に読み込み、公開された window.game /
 * window.ZMF に対してロジックを直接動かして検証する統合テスト。
 * 各テストは同期実行なので、背景の描画ループが割り込むことはない。
 *
 * ブラウザで tests/test.html を開くと結果が画面に表示される。
 * ヘッドレス確認用に window.__testResults にも要約を格納する。
 * ========================================================== */

function runAll() {
    const g = window.game;
    const Z = window.ZMF;
    const M = Z.FLIGHT_MODES;
    const C = Z.constants;

    // キー入力系のテストのために、開始処理(入力リスナー登録)を済ませておく
    const startBtn = document.querySelector('#start-overlay .start-btn');
    if (startBtn && document.getElementById('start-overlay').style.display !== 'none') {
        startBtn.click();
    }

    // ---------- テストランナー ----------
    const groups = [];
    let cur = null;
    const group = (name, body) => {
        cur = { name, cases: [] };
        groups.push(cur);
        try {
            body();
        } catch (err) {
            cur.cases.push({
                name: '例外が発生', ok: false,
                detail: (err && err.message) + ' | ' + (err && err.stack ? err.stack.split('\n')[1] : ''),
            });
        }
    };
    const check = (name, cond, detail = '') => cur.cases.push({ name, ok: !!cond, detail: cond ? '' : detail });
    const approx = (a, b, eps) => Math.abs(a - b) <= eps;

    // ---------- 補助 ----------
    const setMode = (i) => { g.currentModeIndex = i; g.updateModeUI(); };
    // allowBoss=false の間はスコアに関係なくボスを湧かせない(テストの独立性を保つ)
    const step = (n, allowBoss = false) => {
        for (let k = 0; k < n; k++) {
            g.spawnTimer = 1e9;
            if (!allowBoss && !g.boss.active) g.nextBossScore = Number.MAX_SAFE_INTEGER;
            g.update(1 / 60);
        }
    };
    const countActive = (pool) => { let n = 0; pool.forEachActive(() => n++); return n; };
    const withRandom = (val, fn) => {
        const orig = Math.random;
        Math.random = () => val;
        try { return fn(); } finally { Math.random = orig; }
    };
    const spawnEnemy = (x, y, z, hp = 1, size = 10) => {
        const e = g.enemies.get();
        e.id = ++g.enemyIdCounter;
        e.size = size; e.hp = hp; e.locked = false;
        e.mesh.position.set(x, y, z); e.vel.set(0, 0, 0);
        e.mesh.scale.setScalar(size); e.mesh.visible = true;
        e.mesh.material = g.enemyMats[0]; e.colorHex = '#ff3366';
        return e;
    };
    const placeBullet = (x, y, z) => {
        const b = g.bullets.get();
        b.mesh.position.set(x, y, z); b.vel.set(0, 0, 0); b.mesh.visible = true;
        return b;
    };
    const placeBossShot = (x, y, z) => {
        const s = g.enemyShots.get();
        s.mesh.position.set(x, y, z); s.vel.set(0, 0, 0); s.mesh.visible = true;
        return s;
    };
    const newestEnemy = () => {
        let best = null;
        g.enemies.forEachActive(e => { if (!best || e.id > best.id) best = e; });
        return best;
    };
    // 仮想クロックで実ループを1フレーム進める(一時停止判定の確認用)
    const runLoopFrame = (ms = 16) => {
        const now = (g.lastTime || 0) + ms;
        g._lastFrameTs = null;
        g.loop(now);
    };

    // =========================================================
    group('初期化 / 公開API', () => {
        check('window.game が生成されている', !!g);
        check('window.ZMF が公開されている', !!Z);
        check('機体モードは3種類', M.length === 3, `実際: ${M.length}`);
        check('サブ武器は3種類', Object.keys(Z.SUB_WEAPONS).length === 3);
        check('主要メソッドが存在する',
            typeof g.reset === 'function' && typeof g.damagePlayer === 'function' &&
            typeof g.equipSubWeapon === 'function' && typeof g.openHelp === 'function');
        check('ボス・キー設定のメソッドが存在する',
            typeof g.spawnBoss === 'function' && typeof g.damageBoss === 'function' &&
            typeof g.setKeyBinding === 'function' && typeof g.resetKeyBindings === 'function');
    });

    // =========================================================
    group('フライト慣性モデル', () => {
        g.reset(); setMode(1);
        g.input.x = 1; g.input.y = 0;
        step(30);
        check('右入力で右へ移動する', g.player.pos.x > 5, `x=${g.player.pos.x.toFixed(1)}`);

        g.input.x = 0;
        const speedBefore = Math.hypot(g.player.vel.x, g.player.vel.y);
        step(60);
        const speedAfter = Math.hypot(g.player.vel.x, g.player.vel.y);
        check('入力を離すと抵抗で減速する', speedAfter < speedBefore, `${speedBefore.toFixed(0)}→${speedAfter.toFixed(0)}`);

        g.reset(); setMode(1);
        g.player.pos.x = C.BOUND_X + 60; g.player.vel.x = 120;
        step(3);
        check('右端で座標がクランプされる', g.player.pos.x <= C.BOUND_X + 0.01, `x=${g.player.pos.x.toFixed(1)}`);
        check('右端で速度が反発(符号反転)する', g.player.vel.x < 0, `vx=${g.player.vel.x.toFixed(1)}`);
    });

    // =========================================================
    group('モード切替', () => {
        g.reset();
        g.currentModeIndex = 1; g.switchMode();
        check('標準→重装へ切替', g.currentModeIndex === 2, `idx=${g.currentModeIndex}`);
        g.switchMode();
        check('重装→軽量へ循環', g.currentModeIndex === 0, `idx=${g.currentModeIndex}`);
        check('モードごとに質量が異なる', M[0].mass !== M[1].mass && M[1].mass !== M[2].mass);
        check('モードごとに抵抗が異なる', M[0].drag !== M[1].drag && M[1].drag !== M[2].drag);
    });

    // =========================================================
    group('モード固有の個性(防御・連射・火力)', () => {
        const dmgFor = (idx) => {
            g.reset(); setMode(idx);
            g.hp = 100; g.player.hitInvincible = 0;
            g.damagePlayer(10);
            return 100 - g.hp;
        };
        const dLight = dmgFor(0), dStd = dmgFor(1), dHeavy = dmgFor(2);
        check('軽量は被弾ダメージが大きい(装甲弱)', approx(dLight, 10 * M[0].damageMult, 0.01), `受けた=${dLight}`);
        check('重装は被弾ダメージが小さい(装甲強)', approx(dHeavy, 10 * M[2].damageMult, 0.01), `受けた=${dHeavy}`);
        check('装甲の強弱が 軽量>標準>重装 の順', dLight > dStd && dStd > dHeavy, `${dLight}/${dStd}/${dHeavy}`);

        check('連射間隔が 軽量<標準<重装', M[0].fireInterval < M[1].fireInterval && M[1].fireInterval < M[2].fireInterval,
            `${M[0].fireInterval}/${M[1].fireInterval}/${M[2].fireInterval}`);

        g.reset(); setMode(0);
        let e = spawnEnemy(0, 0, -300, 2);
        placeBullet(0, 0, -300);
        step(1);
        check('軽量の弾は1発で威力1(耐久2を1発で倒せない)', e.active && e.hp === 1, `hp=${e.hp} active=${e.active}`);

        g.reset(); setMode(2);
        e = spawnEnemy(0, 0, -300, 2);
        placeBullet(0, 0, -300);
        step(1);
        check('重装の弾は1発で威力2(耐久2を1発で撃破)', !e.active, `active=${e.active}`);
    });

    // =========================================================
    group('通常ショット', () => {
        g.reset(); setMode(1);
        g.lastFireTime = 0; g.input.fire = true; g.player.freezeTimer = 0;
        step(1);
        check('ショットで弾が生成される', countActive(g.bullets) >= 1, `弾=${countActive(g.bullets)}`);
        let anyForward = false;
        g.bullets.forEachActive(b => { if (b.vel.z < -100) anyForward = true; });
        check('弾は前方(-Z)へ飛ぶ', anyForward);
        g.input.fire = false;
    });

    // =========================================================
    group('一斉ロックオン → 追尾レーザー', () => {
        g.reset();
        spawnEnemy(-40, 0, -300); spawnEnemy(0, 0, -300); spawnEnemy(40, 0, -300);
        g.input.lock = true;
        step(30);
        check('前方円錐内の3機をロックする', g.player.lockedTargets.length === 3, `ロック=${g.player.lockedTargets.length}`);
        g.input.lock = false;
        step(1);
        check('ボタンを離すとロック数ぶん発射される', countActive(g.homingLasers) === 3, `弾=${countActive(g.homingLasers)}`);
        check('発射後に短い硬直に入る', g.player.freezeTimer > 0, `freeze=${g.player.freezeTimer.toFixed(2)}`);
    });

    // =========================================================
    group('サブ武器: ハルバード(照射レーザー・5秒CT)', () => {
        g.reset();
        g.equipSubWeapon('halberd');
        check('装備される', g.player.subWeapon === 'halberd');
        check('取得で300点入る', g.score === 300, `score=${g.score}`);

        g.input.sub = true;
        step(3);
        check('押している間ビームが出る', g.player.beamActive && g.beamGroup.visible);

        const e = spawnEnemy(0, 0, -300, 2);
        step(45); // 約0.75秒照射(14dps×0.75≈10 > 耐久2)
        check('ビームの継続ダメージで敵を倒す', !e.active, `hp=${e.hp.toFixed(1)}`);

        g.input.sub = false;
        step(1);
        check('離すとビームが消える', !g.player.beamActive);
        // 約0.8秒しか使っていないので、クールタイムは最低値の約1秒になる
        check('短時間の照射なら短いクールタイム(最低1秒)',
            g.player.subCooldown >= 0.9 && g.player.subCooldown <= 1.5,
            `CT=${g.player.subCooldown.toFixed(2)}`);
    });

    // =========================================================
    group('ハルバードの照射時間上限(5秒)', () => {
        g.reset();
        g.equipSubWeapon('halberd');
        g.input.sub = true;
        step(3);
        check('照射が始まる', g.player.beamActive);

        // 押しっぱなしのまま、自動停止するまで進める
        let frames = 3;
        while (g.player.beamActive && frames < 400) { step(1); frames++; }
        check('約5秒(300フレーム)で自動停止する', frames >= 295 && frames <= 310, `frames=${frames}`);
        check('フル使用時のクールタイムは約5秒', approx(g.player.subCooldown, 5, 0.1), `CT=${g.player.subCooldown.toFixed(2)}`);

        step(30);
        check('押しっぱなしでも再照射されない(CT中)', !g.player.beamActive && g.player.subCooldown > 0,
            `CT=${g.player.subCooldown.toFixed(2)}`);
        g.input.sub = false;
    });

    // =========================================================
    group('ハルバードの残量ゲージ', () => {
        g.reset();
        g.equipSubWeapon('halberd');
        g.input.sub = true;
        step(150); // 約2.5秒照射 = 残り時間約50%
        const w = parseFloat(document.getElementById('subcd-fill').style.width);
        check('照射中はゲージが残り時間を示す(約50%)', w > 35 && w < 65, `w=${w}%`);
        g.input.sub = false;
        step(1);
    });

    // =========================================================
    group('サブ武器: コメット(単発誘導弾・1秒CT)', () => {
        g.reset();
        g.equipSubWeapon('comet');
        const e = spawnEnemy(80, 40, -400);
        g.input.sub = true;
        step(1);
        check('1発だけ発射される', countActive(g.comets) === 1, `弾=${countActive(g.comets)}`);
        check('クールタイムは約1秒', approx(g.player.subCooldown, 1, 0.05), `CT=${g.player.subCooldown.toFixed(2)}`);
        g.input.sub = false;
        step(90);
        check('誘導して敵に命中する', !e.active);
    });

    // =========================================================
    group('サブ武器: ホーミングミサイル(10発・10秒CT)', () => {
        g.reset();
        g.equipSubWeapon('missile');
        const e1 = spawnEnemy(-100, 50, -500);
        const e2 = spawnEnemy(120, -60, -450);
        g.input.sub = true;
        step(1);
        check('10発が一斉に発射される', countActive(g.missiles) === C.MISSILE_COUNT, `弾=${countActive(g.missiles)}`);
        check('クールタイムは約10秒', approx(g.player.subCooldown, 10, 0.1), `CT=${g.player.subCooldown.toFixed(1)}`);
        let vySum = 0, cnt = 0;
        g.missiles.forEachActive(m => { vySum += Math.abs(m.vel.y); cnt++; });
        check('打ち出しは垂直方向が主体', (vySum / cnt) > 250, `平均|vy|=${(vySum / cnt).toFixed(0)}`);
        g.input.sub = false;
        step(200);
        check('その後ホーミングで敵を追尾・撃破する', !e1.active && !e2.active, `e1=${e1.active} e2=${e2.active}`);
    });

    // =========================================================
    group('サブ武器はショットと同時に使える', () => {
        g.reset();
        g.equipSubWeapon('comet');
        g.lastFireTime = 0;
        g.input.fire = true; g.input.sub = true;
        spawnEnemy(0, 30, -400);
        step(1);
        check('同フレームで通常弾とサブ武器が両方出る',
            countActive(g.bullets) >= 1 && countActive(g.comets) >= 1,
            `弾=${countActive(g.bullets)} コメット=${countActive(g.comets)}`);
        g.input.fire = false; g.input.sub = false;
    });

    // =========================================================
    group('スコアと難易度スケーリング', () => {
        g.reset();
        check('初期レベルは1', g.level === 1);
        g.addScore(1499);
        check('1499点ではレベル1', g.level === 1, `lv=${g.level}`);
        g.addScore(1);
        check('1500点でレベル2', g.level === 2, `lv=${g.level}`);
        g.reset();
        g.addScore(4600);
        check('4600点でレベル4', g.level === 4, `lv=${g.level}`);

        g.reset();
        withRandom(0.999, () => {
            const small = spawnEnemy(0, 0, -300, 1, 10);
            g.destroyEnemy(small);
        });
        check('小型撃破で100点', g.score === 100, `score=${g.score}`);
        withRandom(0.999, () => {
            const big = spawnEnemy(0, 0, -300, 1, 15);
            g.destroyEnemy(big);
        });
        check('大型撃破で+200点', g.score === 300, `score=${g.score}`);

        // レベルに応じた敵の強化(決定論的にスポーンさせて確認)
        g.reset();
        g.nextBossScore = Number.MAX_SAFE_INTEGER; // ボスの介入を防ぐ
        withRandom(0.99, () => { g.spawnTimer = 0; g.update(1 / 60); });
        const lowLvEnemy = newestEnemy();
        const lowHp = lowLvEnemy.hp, lowVz = lowLvEnemy.vel.z;

        g.reset();
        g.addScore(9000); // レベル7
        g.nextBossScore = Number.MAX_SAFE_INTEGER;
        withRandom(0.99, () => { g.spawnTimer = 0; g.update(1 / 60); });
        const hiLvEnemy = newestEnemy();
        check('高レベルほど敵の耐久が高い', hiLvEnemy.hp > lowHp, `lv1=${lowHp} lv7=${hiLvEnemy.hp}`);
        check('高レベルほど敵の突入速度が速い', hiLvEnemy.vel.z > lowVz, `lv1=${lowVz.toFixed(0)} lv7=${hiLvEnemy.vel.z.toFixed(0)}`);
    });

    // =========================================================
    group('HP・被弾・無敵・ゲームオーバー', () => {
        g.reset(); setMode(1);
        check('初期HPは最大', g.hp === C.PLAYER_MAX_HP);

        spawnEnemy(0, 0, 0); // 自機に重ねる
        step(1);
        check('接触で25ダメージ', g.hp === 75, `hp=${g.hp}`);
        check('被弾直後は無敵になる', g.player.hitInvincible > 0);

        spawnEnemy(0, 0, 0);
        step(1);
        check('無敵中は連続被弾しない', g.hp === 75, `hp=${g.hp}`);

        for (let i = 0; i < 3; i++) {
            g.player.hitInvincible = 0;
            spawnEnemy(0, 0, 0);
            step(1);
        }
        check('HP0でゲームオーバーになる', g.state === 'gameover', `state=${g.state}`);
        check('ゲームオーバー画面が表示される', document.getElementById('gameover-overlay').style.display === 'flex');
        check('自機が非表示になる', g.player.group.visible === false);
        check('ヘルプボタンが隠れる', document.getElementById('help-btn').style.display === 'none');
    });

    // =========================================================
    group('リスタート(reset)', () => {
        g.reset();
        check('状態がプレイ中へ戻る', g.state === 'playing');
        check('HPが全回復する', g.hp === C.PLAYER_MAX_HP);
        check('スコア・レベルが初期化される', g.score === 0 && g.level === 1);
        check('サブ武器が未装備に戻る', g.player.subWeapon === null);
        check('自機が再表示される', g.player.group.visible === true);
        check('ゲームオーバー画面が閉じる', document.getElementById('gameover-overlay').style.display === 'none');
        check('ヘルプボタンが再表示される', document.getElementById('help-btn').style.display === 'flex');
        check('ボスとボス弾も消える', !g.boss.active && countActive(g.enemyShots) === 0);
        check('押しっぱなし入力が持ち越されない',
            !g.input.fire && !g.input.sub && !g.input.boost && !g.input.lock && g.input.x === 0);
        const leftover = countActive(g.enemies) + countActive(g.bullets) + countActive(g.homingLasers) +
                         countActive(g.comets) + countActive(g.missiles) + countActive(g.items) + countActive(g.enemyShots);
        check('場のオブジェクトが全消去される', leftover === 0, `残=${leftover}`);
    });

    // =========================================================
    group('アイテム取得によるサブ武器入手', () => {
        g.reset();
        withRandom(0.99, () => g.spawnItem({ x: 5, y: 5, z: 0 }));
        check('アイテムが出現する', countActive(g.items) === 1);
        const itm = g.items.pool.find(i => i.active);
        const type = itm.type;
        check('高乱数ではサブ武器がドロップする', Z.ITEM_TYPES.includes(type), `type=${type}`);
        step(1);
        check('取得でサブ武器を装備する', g.player.subWeapon === type, `装備=${g.player.subWeapon}`);
        check('取得で300点入る', g.score === 300, `score=${g.score}`);
        check('取得したアイテムは消える', countActive(g.items) === 0);

        g.reset();
        g.equipSubWeapon('comet');
        g.equipSubWeapon('missile');
        check('新しいサブ武器で上書きされる', g.player.subWeapon === 'missile');
        check('HUDのサブ武器名が更新される', document.getElementById('sub-name').innerText === 'ホーミングミサイル');
    });

    // =========================================================
    group('修理アイテム', () => {
        g.reset(); setMode(1);
        g.hp = 40; g.updateHpBar();
        g.spawnItem({ x: 5, y: 5, z: 0 }, 'repair');
        step(1);
        check('取得で30回復する', g.hp === 40 + C.REPAIR_HEAL, `hp=${g.hp}`);
        check('回復ボーナスで100点入る', g.score === 100, `score=${g.score}`);
        check('サブ武器の装備は変わらない', g.player.subWeapon === null);

        g.hp = 90; g.updateHpBar();
        g.spawnItem({ x: 5, y: 5, z: 0 }, 'repair');
        step(1);
        check('最大HPを超えて回復しない', g.hp === C.PLAYER_MAX_HP, `hp=${g.hp}`);

        // 低乱数では修理アイテムがドロップする(30%枠)
        g.reset();
        withRandom(0.1, () => g.spawnItem({ x: 0, y: 0, z: -500 }));
        const itm = g.items.pool.find(i => i.active);
        check('低乱数では修理アイテムがドロップする', itm && itm.type === 'repair', `type=${itm && itm.type}`);
    });

    // =========================================================
    group('ボス戦', () => {
        g.reset(); setMode(1);
        check('開始時はボス不在', !g.boss.active);
        check('初回ボスの出現基準スコア', g.nextBossScore === C.BOSS_FIRST_SCORE, `next=${g.nextBossScore}`);

        g.addScore(C.BOSS_FIRST_SCORE);
        step(1, true);
        check('基準スコア到達でボスが出現する', g.boss.active);
        check('ボスの耐久ゲージが表示される', document.getElementById('boss-bar-wrap').style.display === 'block');
        check('ボス耐久はレベルに比例する', g.boss.maxHp === 80 + g.level * 25, `maxHp=${g.boss.maxHp}`);

        // ボス戦中は雑魚の出現間隔が延びる(同一乱数で比較)
        const bossInterval = withRandom(0.5, () => { g.spawnTimer = 0; g.update(1 / 60); return g.spawnTimer; });
        g.boss.active = false;
        const savedNext = g.nextBossScore;
        g.nextBossScore = Number.MAX_SAFE_INTEGER;
        const normalInterval = withRandom(0.5, () => { g.spawnTimer = 0; g.update(1 / 60); return g.spawnTimer; });
        g.nextBossScore = savedNext;
        g.boss.active = true;
        check('ボス戦中は雑魚の出現間隔が延びる', bossInterval > normalInterval * 2,
            `boss=${bossInterval.toFixed(2)} normal=${normalInterval.toFixed(2)}`);

        step(80, true); // 約1.3秒:初回発射(1.2秒)を跨ぐ
        check('ボスが自機を狙って弾を撃つ', countActive(g.enemyShots) > 0, `shots=${countActive(g.enemyShots)}`);

        const hpBefore = g.boss.hp;
        placeBullet(g.boss.mesh.position.x, g.boss.mesh.position.y, g.boss.mesh.position.z);
        step(1, true);
        check('通常弾でボスにダメージが入る', g.boss.hp < hpBefore, `${hpBefore.toFixed(0)}→${g.boss.hp.toFixed(0)}`);

        // ロックオンと追尾レーザーの対象になる
        g.boss.mesh.position.set(0, 0, -400);
        g.player.pos.set(0, 0, 0);
        g.player.hitInvincible = 5; // 検証中の被弾を防ぐ
        g.input.lock = true;
        step(45, true);
        check('ボスをロックオンできる', g.player.lockedTargets.includes(g.boss));
        g.input.lock = false;
        step(1, true);
        let lasersAtBoss = 0;
        g.homingLasers.forEachActive(l => { if (l.target === g.boss) lasersAtBoss++; });
        check('追尾レーザーがボスを狙う', lasersAtBoss >= 1, `lasers=${lasersAtBoss}`);

        // 撃破(残存ボス弾のクリアも確認する)
        placeBossShot(200, 200, -300);
        const scoreBefore = g.score;
        g.damageBoss(999999);
        check('撃破でボスが退場する', !g.boss.active);
        check('撃破と同時に残ったボス弾が消える', countActive(g.enemyShots) === 0,
            `shots=${countActive(g.enemyShots)}`);
        check('撃破ボーナスが入る', g.score - scoreBefore === C.BOSS_BONUS_SCORE, `+${g.score - scoreBefore}`);
        let dropped = null;
        g.items.forEachActive(i => { dropped = i; });
        check('修理アイテムを確定ドロップする', dropped && dropped.type === 'repair', `type=${dropped && dropped.type}`);
        check('次のボス基準が更新される', g.nextBossScore === g.score + C.BOSS_SCORE_INTERVAL,
            `next=${g.nextBossScore} score=${g.score}`);
        check('耐久ゲージが隠れる', document.getElementById('boss-bar-wrap').style.display === 'none');
    });

    // =========================================================
    group('ボス弾の被弾', () => {
        g.reset(); setMode(1);
        placeBossShot(0, 0, 0);
        g.player.hitInvincible = 0;
        step(1);
        check('ボス弾でダメージを受ける', g.hp === C.PLAYER_MAX_HP - C.BOSS_SHOT_DAMAGE, `hp=${g.hp}`);
        check('命中した弾は消える', countActive(g.enemyShots) === 0);

        g.reset(); setMode(1);
        placeBossShot(0, 0, 0);
        g.input.boost = true;
        step(1);
        check('無敵中(ブースト)はボス弾を受けない', g.hp === C.PLAYER_MAX_HP, `hp=${g.hp}`);
        g.input.boost = false;
    });

    // =========================================================
    group('キーコンフィグ', () => {
        localStorage.removeItem(Z.storageKeys.keys);
        g.resetKeyBindings();
        check('初期キー割り当てが正しい',
            g.keyBindings.fire === 'Space' && g.keyBindings.sub === 'KeyR' && g.keyBindings.help === 'KeyH');
        check('設定UIに全アクションの行がある',
            document.querySelectorAll('#keyconfig-rows .keyconfig-row').length === Object.keys(Z.DEFAULT_KEYS).length);
        check('キー名が読みやすく表示される', Z.keyLabel('Space') === 'SPACE' && Z.keyLabel('KeyR') === 'R');

        g.setKeyBinding('fire', 'KeyJ');
        check('ショットをJキーへ変更できる', g.keyBindings.fire === 'KeyJ');
        const saved = JSON.parse(localStorage.getItem(Z.storageKeys.keys));
        check('変更が保存される', saved && saved.fire === 'KeyJ');

        g.reset();
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ' }));
        check('変更後のキーで入力が入る', g.input.fire === true);
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyJ' }));
        check('離すと入力が切れる', g.input.fire === false);
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
        check('元のキーでは反応しない', g.input.fire === false);
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));

        g.setKeyBinding('boost', 'KeyJ'); // ショットがKeyJ使用中 → 入れ替わるはず
        check('重複キーは入れ替えで解決する',
            g.keyBindings.boost === 'KeyJ' && g.keyBindings.fire === 'KeyE',
            `boost=${g.keyBindings.boost} fire=${g.keyBindings.fire}`);

        // 「キーを押して割り当て」の流れ
        g.keyCaptureAction = 'blink';
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' }));
        check('押したキーがそのまま割り当てられる', g.keyBindings.blink === 'KeyZ' && g.keyCaptureAction === null);
        check('割り当て中のキーはゲーム操作にならない', g.input.blink === false);

        g.resetKeyBindings();
        check('初期設定に戻せる', g.keyBindings.fire === 'Space' && g.keyBindings.blink === 'KeyQ');
    });

    // =========================================================
    group('ハイスコア保存', () => {
        localStorage.removeItem(Z.storageKeys.best);
        g.reset();
        g.addScore(777);
        g.gameOver();
        check('ゲームオーバーでベストスコアを保存する', localStorage.getItem(Z.storageKeys.best) === '777');
        check('ベストスコアが表示される', document.getElementById('best-score').innerText === '777');
        check('撃破数が表示される', document.getElementById('final-kills').innerText === String(g.killCount));

        g.reset();
        g.addScore(10);
        g.gameOver();
        check('より低いスコアでは更新しない', localStorage.getItem(Z.storageKeys.best) === '777');
        check('表示は過去のベストのまま', document.getElementById('best-score').innerText === '777');
        g.reset();
    });

    // =========================================================
    group('オブジェクトプールの上限', () => {
        g.reset();
        for (let i = 0; i < 200; i++) g.spawnHomingLaser(g.player.pos, g.player.vel, null);
        check('レーザーはプール上限を超えない', countActive(g.homingLasers) <= 60, `active=${countActive(g.homingLasers)}`);

        g.reset();
        for (let i = 0; i < 200; i++) { const b = g.bullets.get(); if (b) b.mesh.visible = true; }
        check('弾はプール上限を超えない', countActive(g.bullets) <= 60, `active=${countActive(g.bullets)}`);
    });

    // =========================================================
    group('一時停止 / ヘルプ', () => {
        g.reset();
        g.openHelp();
        check('ヘルプで一時停止状態になる', g.state === 'paused');
        check('ヘルプ画面が表示される', document.getElementById('help-overlay').style.display === 'flex');
        check('helpOpen フラグが立つ', g.helpOpen === true);

        g.lastTime = 1000; g.input.x = 1; g.spawnTimer = 1e9;
        const pausedX = g.player.pos.x;
        runLoopFrame(16);
        check('一時停止中は自機が動かない', g.player.pos.x === pausedX, `x=${g.player.pos.x.toFixed(2)}`);

        g.closeHelp();
        check('再開でプレイ中へ戻る', g.state === 'playing');
        check('ヘルプ画面が閉じる', document.getElementById('help-overlay').style.display === 'none');

        g.lastTime = 2000; g.input.x = 1; g.spawnTimer = 1e9; g.nextBossScore = Number.MAX_SAFE_INTEGER;
        const resumedX = g.player.pos.x;
        runLoopFrame(16);
        check('再開後は自機が動く', g.player.pos.x !== resumedX, `x=${g.player.pos.x.toFixed(2)}`);
        g.input.x = 0;

        g.toggleHelp();
        check('トグルで一時停止', g.state === 'paused');
        g.toggleHelp();
        check('トグルで再開', g.state === 'playing');
    });

    // =========================================================
    group('HUD 表示の更新', () => {
        g.reset();
        g.addScore(250);
        check('スコア表示が更新される', document.getElementById('score-display').innerText === '250');
        g.equipSubWeapon('comet');
        check('サブ武器名が更新される', document.getElementById('sub-name').innerText === 'コメット');
        setMode(1); g.hp = 100; g.player.hitInvincible = 0;
        g.damagePlayer(50);
        check('HPバー幅が減る', parseFloat(document.getElementById('hp-fill').style.width) < 100,
            `w=${document.getElementById('hp-fill').style.width}`);
        g.healPlayer(50);
        check('回復でHPバー幅が戻る', parseFloat(document.getElementById('hp-fill').style.width) === 100,
            `w=${document.getElementById('hp-fill').style.width}`);

        setMode(2);
        check('重装は防御ラベルが「強」', document.getElementById('trait-def').innerText === '強');
        check('重装は火力ラベルが「高」', document.getElementById('trait-pow').innerText === '高');
        check('重装は連射ラベルが「遅」', document.getElementById('trait-fire').innerText === '遅');
        check('強みラベルは good 配色', document.getElementById('trait-def').className.includes('trait-good'));
        check('弱みラベルは bad 配色', document.getElementById('trait-fire').className.includes('trait-bad'));
    });

    // =========================================================
    group('UI表示の簡素化', () => {
        check('デバッグ表示(質量・抵抗)が撤去されている',
            !document.getElementById('stat-mass') && !document.getElementById('stat-drag'));
        check('モードの長文説明がHUDに無い', !document.getElementById('mode-desc'));
        check('常時表示の操作ガイドが無い', !document.querySelector('#ui-layer .controls'));
        check('HUDは1パネルのみ', document.querySelectorAll('#ui-layer .panel').length === 1);
    });

    // =========================================================
    group('タイトル画面の整理', () => {
        check('タイトルに詳細ガイドカードが無い', !document.querySelector('#start-overlay .guide-card'));
        check('タイトルは簡潔なヒントのみ', !!document.querySelector('#start-overlay .quick-hints'));
        check('詳しい操作説明はヘルプ画面へ移動', !!document.querySelector('#help-overlay .guide-grid'));

        localStorage.setItem(Z.storageKeys.best, '1234');
        g.refreshBestOnTitle();
        check('タイトルにベストスコアが表示される', document.getElementById('start-best').innerText === '1234');
        localStorage.removeItem(Z.storageKeys.best);
    });

    // ---------- 後片付け:テスト後は静止させておく ----------
    g.reset();
    g.state = 'paused';

    // =========================================================
    // 結果の集計と表示
    // =========================================================
    let passed = 0, failed = 0;
    const failures = [];
    groups.forEach(gr => gr.cases.forEach(c => {
        if (c.ok) passed++;
        else { failed++; failures.push(`[${gr.name}] ${c.name} — ${c.detail}`); }
    }));
    const total = passed + failed;

    window.__testResults = { total, passed, failed, failures };
    console.log(`GRAVITY ZERO テスト: ${passed}/${total} 成功` + (failed ? ` / ${failed} 失敗` : ''));
    failures.forEach(f => console.error('FAIL: ' + f));

    renderReport(groups, { total, passed, failed });
}

/** 結果を画面に描画する */
function renderReport(groups, sum) {
    const root = document.getElementById('test-report');
    root.innerHTML = '';

    const h1 = document.createElement('h1');
    h1.textContent = 'GRAVITY ZERO — テストスイート';
    root.appendChild(h1);

    const summary = document.createElement('div');
    summary.id = 'test-summary';
    summary.className = sum.failed === 0 ? 'pass' : 'fail';
    summary.textContent = sum.failed === 0
        ? `✅ 全 ${sum.total} 件 成功`
        : `❌ ${sum.passed}/${sum.total} 成功 ・ ${sum.failed} 件 失敗`;
    root.appendChild(summary);

    groups.forEach(gr => {
        const g = document.createElement('div');
        g.className = 'test-group';
        const okCount = gr.cases.filter(c => c.ok).length;
        g.textContent = `${gr.name}  (${okCount}/${gr.cases.length})`;
        root.appendChild(g);
        gr.cases.forEach(c => {
            const d = document.createElement('div');
            d.className = 'test-case ' + (c.ok ? 'ok' : 'ng');
            d.innerHTML = (c.ok ? '✓ ' : '✗ ') + c.name +
                (c.detail ? ` <span class="detail">(${c.detail})</span>` : '');
            root.appendChild(d);
        });
    });
}

/** window.game と window.ZMF が用意できてから実行する */
function waitAndRun(attempt = 0) {
    if (window.game && window.ZMF) {
        // タブが非表示でも実行できるよう、rAFではなくタイマーで開始する
        setTimeout(() => runAll(), 50);
        return;
    }
    if (attempt > 200) {
        document.getElementById('test-report').innerHTML =
            '<h1 style="color:#ff8095">ゲーム本体の読み込みに失敗しました</h1>';
        return;
    }
    setTimeout(() => waitAndRun(attempt + 1), 20);
}

window.addEventListener('load', () => waitAndRun());
