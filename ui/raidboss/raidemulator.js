'use strict';

// TODO: allow for different playback rates.  The main trickiness
// here is that (1) timeline playback needs to be adjusted and
// (2) delaySeconds/suppressSeconds also need to be fixed.

// TODO: make it possible to scrub around forwards and backwards
// in time in the player.  Forwards is easiest, because the
// player could just play all the logs (silently).  Backwards
// is much harder because it would need to start from the
// beginning again (or some data checkpoint).

// TODO: allow the emulator to suppress events from the game
// such as zone changing or player data changing in raidboss.
// Currently, switching zones will stop the emulator.

// TODO: it would be nice to let the user select their name
// and role to pretend to be somebody else in the log.  The user
// could input this manually, or maybe select from the actors
// detected in the fight.  Although this would require detecting what
// jobs they were, probably by matching on particular skills that
// they likely would use, e.g. / 15:........:name:1F:/ for heavy swing.

let gLogCollector;
let gEmulatorView;

// Responsible for handling importing the fights.
// When a fight is imported, it will call the addFightCallback.
class LogCollector {
  constructor(addFightCallback) {
    this.currentZone = null;
    // { key:, zoneName:, startDate:, endDate:, durationMs:, logs: }
    this.fights = [];
    this.currentFight = null;
    this.addFightCallback = addFightCallback;
  }

  AppendImportLogs(logs) {
    for (let i = 0; i < logs.length; ++i) {
      let log = logs[i];
      let logZoneChange = this.ParseZoneChange(log);
      if (logZoneChange && logZoneChange != this.currentZone) {
        if (this.currentFight)
          this.EndFight(log);
        this.currentZone = logZoneChange;
      }

      if (this.currentFight) {
        this.currentFight.logs.push(log);
        if (this.IsWipe(log))
          this.EndFight(log);
      } else if (log.match(gLang.countdownEngageRegex())) {
        // For consistency, only start fights on a countdown.  This
        // makes it easy to know where to start all fights (vs
        // reading timeline files or some such).
        if (!this.currentZone)
          console.error('Network log file specifies no zone?');
        this.currentFight = {
          zoneName: this.currentZone,
          startDate: dateFromLogLine(log),
          logs: [log],
          durationMs: null,
          key: this.fights.length,
        };
      }
    }
  }

  EndFight(log) {
    let endDate = dateFromLogLine(log);
    let fight = this.currentFight;
    fight.durationMs = endDate.getTime() - fight.startDate.getTime();
    fight.endDate = endDate;

    // Only add the fight if it hasn't been seen before.  The key
    // generated internally by the collector is always unique so
    // can't be used in this comparison.
    this.currentFight = null;
    for (let i = 0; i < this.fights.length; ++i) {
      let f = this.fights[i];
      if (f.logs[0] == fight.logs[0] && f.currentZone == fight.currentZone)
        return;
    }

    this.fights.push(fight);
    if (this.addFightCallback)
      this.addFightCallback(fight);
  }

  IsWipe(log) {
    // Actor control line list: https://gist.github.com/quisquous/250001cbce232a48e6a9ce772a56675a
    return log.match(/ 21:........:40000010:/) || log.indexOf('00:0038:cactbot wipe') != -1;
  }

  ParseZoneChange(log) {
    let m = log.match(/ 01:Changed Zone to (.*)\./);
    if (!m)
      return;
    return m[1];
  }
}

// Responsible for playing back a fight and emitting events as needed.
class LogPlayer {
  LogPlayer() {
    this.Reset();
  }

  Reset() {
    this.fight = null;
    this.localStartTime = null;
    this.logIdx = null;
  }

  SendLogEvent(logs) {
    let evt = new CustomEvent('onLogEvent', { detail: { logs: logs } });
    document.dispatchEvent(evt);
  }

  SendZoneEvent(zoneName) {
    let evt = new CustomEvent('onZoneChangedEvent', { detail: { zoneName: zoneName } });
    document.dispatchEvent(evt);
  }

  Start(fight) {
    this.localStartMs = +new Date();
    this.logStartMs = fight.startDate.getTime();
    this.fight = fight;
    this.logIdx = 0;

    this.SendZoneEvent(fight.zoneName);
    this.Tick();
  }

  IsPlaying() {
    return !!this.fight;
  }

  Tick() {
    // The last raf doesn't get cancelled, so just silently ignore.
    if (!this.fight)
      return;

    let timeMs = +new Date();
    let elapsedMs = timeMs - this.localStartMs;
    let cutOffTimeMs = this.logStartMs + elapsedMs;

    // Walk through all logs that should be emitted since the last tick.
    let logs = [];
    while (dateFromLogLine(this.fight.logs[this.logIdx]).getTime() <= cutOffTimeMs) {
      logs.push(this.fight.logs[this.logIdx]);
      this.logIdx++;

      if (this.logIdx >= this.fight.logs.length) {
        this.SendLogEvent(logs);
        this.Stop();
        return;
      }
    }
    this.SendLogEvent(logs);
  }

  Stop() {
    // FIXME: there's surely some better way to stop things.
    this.SendLogEvent(['00:0038:cactbot wipe']);
    this.Reset();
  }
};

// Responsible for manipulating any UI on screen, and starting and stopping
// the log player when needed.
class EmulatorView {
  constructor(fightListElement, timerElement, elapsedElement, infoElement) {
    this.fightListElement = fightListElement;
    this.timerElement = timerElement;
    this.elapsedElement = elapsedElement;
    this.infoElement = infoElement;

    this.logPlayer = new LogPlayer();
    this.fightMap = {};
    this.selectedFight = null;
    this.startTimeLocalMs = null;
  }

  DateToTimeStr(date) {
    let pad2 = function(num) {
      return ('0' + num).slice(-2);
    };
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  AddFight(fight) {
    // Note: this uses radio inputs to allow the user to select from a list of
    // fights that were imported.  It might seem like a <select> would be
    // more natural, but the native UI for a <select> behaves very badly inside
    // of CEF, sometimes causing the overlay to be resized (?!).
    let parentDiv = document.createElement('div');
    parentDiv.classList.add('fight-option');
    let radioElement = document.createElement('input');
    let fightKey = 'fight' + fight.key;
    this.fightMap[fightKey] = fight;

    radioElement.id = fightKey;
    radioElement.name = 'fight';
    radioElement.type = 'radio';
    let labelElement = document.createElement('label');
    labelElement.setAttribute('for', radioElement.id);

    let dateStr = this.DateToTimeStr(fight.startDate);
    let durTotalSeconds = Math.ceil(fight.durationMs / 1000);
    let durMinutes = Math.floor(durTotalSeconds / 60);
    let durStr = '';
    if (durMinutes > 0)
      durStr += durMinutes + 'm';
    durStr += (durTotalSeconds % 60) + 's';
    labelElement.innerText = fight.zoneName + ', ' + dateStr + ', ' + durStr;

    parentDiv.appendChild(radioElement);
    parentDiv.appendChild(labelElement);
    this.fightListElement.appendChild(parentDiv);

    radioElement.addEventListener('change', (function() {
      this.SelectFight(radioElement.id);
    }).bind(this));
  }

  SelectFight(fightKey) {
    let fight = this.fightMap[fightKey];
    this.selectedFight = fight;

    if (!this.playingFight)
      this.ShowFightInfo(this.selectedFight);
  }

  Start() {
    if (!this.selectedFight)
      return;
    let fight = this.selectedFight;

    let durTotalSeconds = Math.ceil(fight.durationMs / 1000);
    this.timerElement.style.transition = '0s';
    this.timerElement.style.width = '0%';
    this.timerElement.style.transition = durTotalSeconds + 's linear';
    this.timerElement.style.width = '100%';

    this.logPlayer.Start(fight);
    this.localStartMs = +new Date();
    this.playingFight = fight;
    this.ShowFightInfo(this.playingFight);
    this.Tick();
  }

  Tick() {
    this.logPlayer.Tick();
    if (!this.logPlayer.IsPlaying())
      return;

    let localTimeMs = +new Date();
    let elapsedMs = localTimeMs - this.localStartMs;
    let totalTimeMs = this.playingFight.durationMs;

    let msToTimeStr = function(ms) {
      let pad = function(num, pad) {
        return ('00' + num).slice(-pad);
      };
      let minStr = pad(Math.floor(ms / 60000), 2);
      let secStr = pad(Math.ceil(ms / 1000) % 60, 2);
      return minStr + ':' + secStr;
    };

    this.elapsedElement.innerText =
        msToTimeStr(elapsedMs) + ' / ' + msToTimeStr(totalTimeMs);

    window.requestAnimationFrame(this.Tick.bind(this));
  }

  Stop() {
    this.logPlayer.Stop();
    this.localStartMs = null;
    this.playingFight = null;

    this.timerElement.style.transition = '0s';
    this.timerElement.style.width = '0%';

    this.ShowFightInfo(this.selectedFight);
  }

  ShowFightInfo(fight) {
    if (!fight) {
      this.infoElement.innerText = '';
      return;
    }
    // Use cached fight info, if available.
    if (fight.info) {
      this.infoElement.innerText = fight.info;
      return;
    }

    // Walk through all the logs and figure out info from the pull.
    let isClear = false;
    let actorMap = {};
    for (let i = 0; i < fight.logs.length; ++i) {
      let log = fight.logs[i];
      if (log.indexOf(' 21:') != -1 && log.match(/ 21:........:40000003:/))
        isClear = true;

      if (log.indexOf(' 15:') != -1 || log.indexOf(' 16:') != -1) {
        let m = log.match(/ 1[56]:........:([^:]*):/);
        actorMap[m[1]] = true;
      }
    }

    let info = fight.zoneName + '\n';
    info += 'From ' + this.DateToTimeStr(fight.startDate);
    info += ' to ' + this.DateToTimeStr(fight.endDate);
    info += isClear ? ' (Clear)' : ' (Wipe?)';
    info += '\n';

    let actors = Object.keys(actorMap).filter(function(x) {
      return x;
    }).sort();
    info += actors.join(', ');

    fight.info = info;
    this.infoElement.innerText = info;
  }
};

function dateFromLogLine(log) {
  let m = log.match(/\[(\d\d):(\d\d):(\d\d).(\d\d\d)\]/);
  if (!m)
    return;
  let date = new Date();
  date.setHours(m[1]);
  date.setMinutes(m[2]);
  date.setSeconds(m[3]);
  date.setMilliseconds(m[4]);
  return date;
}

// Only listen to the import log event here and *not* the zone changed event.
// The log collector figures out the zone from the logs itself, and not through
// what ACT sends while importing (which races with sending logs).
document.addEventListener('onImportLogEvent', function(e) {
  gLogCollector.AppendImportLogs(e.detail.logs);
});

document.addEventListener('DOMContentLoaded', function() {
  let fightListElement = document.getElementById('fight-picker');
  let timerElement = document.getElementById('emulator-log-timer');
  let elapsedElement = document.getElementById('elapsed-time');
  let infoElement = document.getElementById('info-panel');
  gEmulatorView = new EmulatorView(fightListElement, timerElement, elapsedElement, infoElement);
  gLogCollector = new LogCollector(gEmulatorView.AddFight.bind(gEmulatorView));
});

// Share user config for raidboss, in terms of options and css styling, etc.
UserConfig.getUserConfigLocation('raidboss');

function playLogFile() {
  gEmulatorView.Start();
}

function stopLogFile() {
  gEmulatorView.Stop();
}
