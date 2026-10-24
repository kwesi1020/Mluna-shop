'use strict';
/*
 * Minimal HTML tokenizer used only by tests to check the output of our own templates.
 * UNEXECUTED. It is NOT a full HTML5 parser: it is strict on purpose and records an error for
 * stray '<', bad attribute characters, unquoted values and unterminated tags/attributes/comments.
 */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
function decode(s){ return s.replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ENT[e]); }

function tokenize(html){
  const tags = [], text = [], errors = [];
  let i = 0;
  while(i < html.length){
    const lt = html.indexOf('<', i);
    if(lt === -1){ text.push(decode(html.slice(i))); break; }
    if(lt > i) text.push(decode(html.slice(i, lt)));
    if(html.startsWith('<!--', lt)){
      tags.push({ name: '#comment', attrs: {} });
      const e = html.indexOf('-->', lt + 4);
      if(e === -1){ errors.push('unterminated comment'); break; }
      i = e + 3; continue;
    }
    const m = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(html.slice(lt));
    if(!m){ errors.push('stray < at ' + lt); i = lt + 1; continue; }
    let j = lt + m[0].length;
    const attrs = {};
    for(;;){
      while(/\s/.test(html[j] || '')) j++;
      if(j >= html.length){ errors.push('unterminated tag <' + m[2] + '>'); break; }
      if(html[j] === '>'){ j++; break; }
      if(html[j] === '/' && html[j + 1] === '>'){ j += 2; break; }
      const am = /^[^\s"'<>\/=]+/.exec(html.slice(j));
      if(!am){ errors.push('bad attribute char ' + JSON.stringify(html[j]) + ' in <' + m[2] + '>'); j++; continue; }
      const name = am[0]; j += name.length;
      let val = '';
      while(/\s/.test(html[j] || '')) j++;
      if(html[j] === '='){
        j++;
        while(/\s/.test(html[j] || '')) j++;
        const q = html[j];
        if(q === '"' || q === "'"){
          const e = html.indexOf(q, j + 1);
          if(e === -1){ errors.push('unterminated attribute value'); j = html.length; break; }
          val = decode(html.slice(j + 1, e)); j = e + 1;
        } else {
          const um = /^[^\s>]+/.exec(html.slice(j));
          val = um ? um[0] : ''; j += val.length;
          errors.push('unquoted attribute value on ' + name);
        }
      }
      attrs[name.toLowerCase()] = val;
    }
    tags.push({ name: m[2].toLowerCase(), close: m[1] === '/', attrs: attrs });
    i = j;
  }
  return { tags: tags, text: text, errors: errors };
}

module.exports = { tokenize, decode };
