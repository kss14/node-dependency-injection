module.exports = {
  services: {
    foo: {
      class: './../foo',
      arguments: ['@bar', '%fs-extra', 'foo-bar'],
      tags: [
        {name: 'fooTag'}
      ]
    },
    bar: {
      class: './../bar',
      calls: [
        { method: 'setFooBar', arguments: ['@foobar'] }
      ],
      tags: [
        {name: 'fooTag'}
      ]
    },
    foobar: {class: './../foobar'},
    f: '@foo'
  }
}