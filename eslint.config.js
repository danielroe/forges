import antfu from '@antfu/eslint-config'

export default antfu({
  vue: true,
})
  .append({
    ignores: ['./test/fixtures/**', './notes/**'],
  })
