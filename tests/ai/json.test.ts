import { extractJson } from '../../src/ai/json';

describe('extractJson', () => {
  it.each([
    ['```json\n{"a":1}\n```', { a: 1 }],
    ['Вот ответ: {"a":[1,2]} спасибо', { a: [1, 2] }],
    ['[1,2]', [1, 2]],
  ])('extracts %s', (text, value) => expect(extractJson(text)).toEqual(value));

  it('unwraps a fence without a language tag', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('unwraps a fence that has chatter around it', () => {
    expect(extractJson('Конечно!\n```json\n{"a":"b"}\n```\nГотово.')).toEqual({ a: 'b' });
  });

  it('unwraps an upper-case tag and CRLF line breaks', () => {
    expect(extractJson('```JSON\r\n{"a":1}\r\n```')).toEqual({ a: 1 });
  });

  it('takes a bare document as is, whitespace around it ignored', () => {
    expect(extractJson('  \n{"a":{"b":[true,null]}}\n ')).toEqual({ a: { b: [true, null] } });
  });

  it('finds the document inside a fence that also has prose in it', () => {
    expect(extractJson('```json\nВот: {"a":1} — всё\n```')).toEqual({ a: 1 });
  });

  it('cuts an array out of prose by the matching brackets', () => {
    expect(extractJson('Список: [{"a":1},{"a":2}] — готово')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('pairs the opening bracket with its own closing one', () => {
    expect(extractJson('{"a":1} (см. [1])')).toEqual({ a: 1 });
  });

  it('keeps braces and brackets that sit inside strings', () => {
    expect(extractJson('Ответ: {"a":"}]{["} конец')).toEqual({ a: '}]{[' });
  });

  it('parses a fence that is not closed, from the bracket on', () => {
    expect(extractJson('```json\n{"a":1}')).toEqual({ a: 1 });
  });

  it.each(['нет json', '', '   ', '{"a":', '{ не json }', '```json\n```', 'only ] before [ here'])(
    'throws SyntaxError on %j',
    (text) => expect(() => extractJson(text)).toThrow(SyntaxError),
  );
});
