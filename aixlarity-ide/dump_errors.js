const fs = require('fs');
window.addEventListener('error', e => { fs.appendFileSync('/Users/voidful/PycharmProjects/ClaudeCode/aixlarity-err.log', e.error + '\n'); });
