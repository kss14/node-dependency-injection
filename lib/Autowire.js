import path from 'path'
import fs from 'fs'
import json5 from 'json5'
import { parse } from '@typescript-eslint/typescript-estree'
import Definition from './Definition'
import Reference from './Reference'
import ServiceFile from './ServiceFile'
import AutowireIdentifier from './AutowireIdentifier'
import ContainerDefaultDirMustBeSet from './Exception/ContainerDefaultDirMustBeSet'

export default class Autowire {
  /**
   * @param {ContainerBuilder} container
   * @param {string} tsConfigFullPath
   */
  constructor (container, tsConfigFullPath = null) {
    this._ensureContainerIsValidForAutowire(container)
    this._rootDirectory = container.defaultDir
    this._container = container
    this._excludedFolders = []
    this._serviceFile = null
    try {
      this._tsConfigFullPath = tsConfigFullPath || path.join(process.cwd(), 'tsconfig.json')
      this._tsConfigPaths = json5.parse(
        fs.readFileSync(this._tsConfigFullPath, 'utf-8')
      ).compilerOptions.paths
    } catch (e) {
      this._tsConfigPaths = null
    }
  }

  _ensureContainerIsValidForAutowire (container) {
    if (container.defaultDir === null) {
      throw new ContainerDefaultDirMustBeSet()
    }
  }

  /**
   * @return {ContainerBuilder}
   */
  get container () {
    return this._container
  }

  /**
   * @private
   * @param {string}
   * @return {Iterable}
   */
  * _walk (dir) {
    const files = fs.readdirSync(dir, { withFileTypes: true })
    for (const file of files) {
      if (file.isDirectory()) {
        yield * this._walk(path.join(dir, file.name))
        continue
      }
      yield * this._walkFilePath(dir, file.name)
    }
  }

  /**
   * @param {string} dir
   * @param {string} fileName
   * @private
   */
  * _walkFilePath (dir, fileName) {
    try {
      const filePath = path.join(dir, fileName)
      this._ensureFileIsNotExcluded(filePath)
      yield filePath
    } catch (e) {
    }
  }

  /**
   * @private
   * @param {string} filePath
   * @returns {void}
   */
  _ensureFileIsNotExcluded (filePath) {
    this._excludedFolders.forEach(excludedFolder => {
      if (filePath.includes(excludedFolder)) {
        throw new Error('Excluded Folder!')
      }
    })
  }

  /**
   * @param {string} path
   */
  addExclude (relativePath) {
    const fullPathToExclude = path.join(this._rootDirectory, relativePath)
    this._excludedFolders.push(fullPathToExclude)
  }

  /**
   * @private
   * @param {string} path
   * @param {string} type
   * @param {string} extension
   * @returns {Promise}
   */
  async _getServiceIdFromPath (path, type) {
    const namespaceTab = this._getNameSpace(path)
    const namespaceDepth =namespaceTab.length

    if(namespaceDepth > 0){
      return this._getNameSpace(path).join('.') +'.' +type
    }
    
    return type
  }

  /**
   * @return {Promise}
   */
  async process () {
    const promises = []
    for (const filePath of this._walk(this._rootDirectory)) {
      promises.push(this._executeFilePath(filePath))
    }
    await Promise.all(promises)
    if (this._serviceFile instanceof ServiceFile) {
      await this._serviceFile.generateFromContainer(this._container)
    }
  }

  /**
   * @param {string} filePath
   * @returns {Promise}
   * @private
   */
  async _executeFilePath (filePath) {
    const parsedFile = path.parse(filePath)
    if (parsedFile.ext !== '.ts') {
      return
    }
   
    const { classDeclaration, body } = await this._getClassDeclaration(filePath)
    if (!classDeclaration) {
      return
    }

    let Class = require(filePath)

    if (!Class) {
      return
    }
    const namespaces = this._getNameSpaceWithClass(filePath)

    if(namespaces.length === 1 ){
      Class = Class.default
    } else {
      for (const namespace of namespaces) {
        if (Class.hasOwnProperty(namespace)) {
          Class = Class[namespace]
        } else {
          console.log('Namespace non trouvé:', namespace)
          break
        }
      }
  
    }
    
    const definition = await this._getDefinition(
      classDeclaration,
      body,
      parsedFile,
      Class,
      filePath
    )
    if (!definition) {
      return
    }
   
    const serviceId = await this._getServiceIdFromPath(filePath, Class.name)
    this.container.setDefinition(serviceId, definition)
    await this._interfaceImplementations(classDeclaration, body, parsedFile, serviceId)
  }
  /**
   * 
   * @param {string} filePath 
   * @returns {string[]}
   * @private
   */
  _getNameSpace (filePath) {
    let tabFilePathFiltredByCapitalizeWord = filePath
    .split('src\\')
    ?.[1].split('\\')
    ?.filter(part => /^[A-Z]/.test(part))

    tabFilePathFiltredByCapitalizeWord.pop()

    return tabFilePathFiltredByCapitalizeWord
  }
  /**
   * 
   * @param {string} filePath 
   * @returns {string[]}
   * @private
   */
  _getNameSpaceWithClass (filePath) {
    let tabFilePathFiltredByCapitalizeWord = filePath.replace('.ts', '')
    .split('src\\')
    ?.[1].split('\\')
    ?.filter(part => /^[A-Z]/.test(part))

    return tabFilePathFiltredByCapitalizeWord
  }
  /**
   *
   * @param {string} filePath
   * @returns {Promise}
   * @private
   */
  async _getClassDeclaration (filePath) {
    const sourceCode = fs.readFileSync(filePath, 'utf8')
    const namespaceDepth = this._getNameSpace(filePath).length
    const body = parse(sourceCode).body
 
    const classDeclaration = body.find(
      (declaration) => {
        let declarationWithNameSpace = declaration?.declaration

        if (namespaceDepth > 0) {
          for (let i = 0; i < namespaceDepth; i++) {
            declarationWithNameSpace = declarationWithNameSpace?.body
          }
          if(declarationWithNameSpace?.body){
            declarationWithNameSpace = declarationWithNameSpace?.body[0]
          }
        }

        return declaration?.type === 'ExportDefaultDeclaration' 
        || declarationWithNameSpace?.type === 'ExportNamedDeclaration' 
        && namespaceDepth > 0
      }
    )
    
    return { classDeclaration, body }
  }
  _rebuildFilePath(parsedFile){
    return parsedFile.dir+'\\'+parsedFile.base
  }
  /**
   *
   * @param {object} classDeclaration
   * @param {string} body
   * @param {any} parsedFile
   * @param {any} ServiceClass
   * @returns
   * @private
   */
  async _getDefinition (classDeclaration, body, parsedFile, ServiceClass) {

    try {
      const filePath = this._rebuildFilePath(parsedFile)
      const definition = new Definition(ServiceClass)
      const namespaceDepth = this._getNameSpace(filePath).length
      const constructorParams = await this._getConstructorParamsByDefinition(
        definition,
        classDeclaration,
        body,
        parsedFile
      )

      for (const parameterDeclaration of constructorParams) {
        let typeNameForArgument = parameterDeclaration
          .parameter
          .typeAnnotation
          .typeAnnotation
          .typeName

          let importNameForAgument

          if(typeNameForArgument.right){
            importNameForAgument = typeNameForArgument
            for(let i =0 ; i <= namespaceDepth ; i++){
              importNameForAgument = importNameForAgument.left
            }

            typeNameForArgument = typeNameForArgument.right
            importNameForAgument = importNameForAgument.name
          }

          typeNameForArgument = typeNameForArgument.name
          
         
        const argumentId = await this._getIdentifierFromImports(typeNameForArgument, body, parsedFile, importNameForAgument)
        if (!argumentId) {
          continue
        }
        definition.addArgument(new Reference(argumentId), definition.abstract)
      }

      return definition
    } catch (e) {
      //console.log(e)
    }
  }

  /**
   * @private
   * @param {Definition} definition
   * @param {object} classDeclaration
   * @param {any} body
   * @param {any} parsedFile
   * @returns
   */
  async _getConstructorParamsByDefinition (definition, classDeclaration, body, parsedFile) {
    const filePath = this._rebuildFilePath(parsedFile)
    const namespaceDepth = this._getNameSpace(filePath).length
    let declarationWithNameSpace = classDeclaration
   
    if (namespaceDepth > 0) {
      declarationWithNameSpace = declarationWithNameSpace.declaration

      for (let i = 0; i < namespaceDepth; i++) {
        declarationWithNameSpace = declarationWithNameSpace?.body
      }

      declarationWithNameSpace =  declarationWithNameSpace.body[0]
    }

    const constructorDeclaration = declarationWithNameSpace.declaration.body.body.find(
      (method) => method.key.name === 'constructor'
    )

    if (classDeclaration.declaration.abstract) {
      definition.abstract = true
    }

    await this._parentDefinition(classDeclaration, body, parsedFile, definition)
    return constructorDeclaration ? constructorDeclaration.value.params : []
  }

  /**
   * @private
   * @param {object} classDeclaration
   * @param {any} body
   * @param {any} parsedFile
   * @param {Definition} definition
   */
  async _parentDefinition (classDeclaration, body, parsedFile, definition) {
    const filePath = this._rebuildFilePath(parsedFile)
    const namespaceDepth = this._getNameSpace(filePath).length
    let declarationWithNameSpace = classDeclaration
   
    if (namespaceDepth > 0) {
      declarationWithNameSpace = declarationWithNameSpace.declaration

      for (let i = 0; i < namespaceDepth; i++) {
        declarationWithNameSpace = declarationWithNameSpace?.body
      }

      declarationWithNameSpace = declarationWithNameSpace.body[0]
    }
    
    if (classDeclaration.declaration.superClass) {
      const typeParent = classDeclaration.declaration.superClass.name
      const parentId = await this._getIdentifierFromImports(
        typeParent,
        body,
        parsedFile,
      )
      if (parentId) {
        definition.parent = parentId
      }
    }
  }

  /**
   * @private
   * @param {any} classDeclaration
   * @param {any} body
   * @param {any} parsedFile
   * @param {string} serviceId
   */
  async _interfaceImplementations (classDeclaration, body, parsedFile, serviceId) {
    const implementations = classDeclaration.declaration.implements ?? []
    for (const implement of implementations) {
      const interfaceType = implement.expression.name
      const aliasId = await this._getIdentifierFromImports(
        interfaceType,
        body,
        parsedFile,
        filePath
      )
      if (!aliasId || this.container.hasAlias(aliasId)) {
        continue
      }
      this.container.setAlias(aliasId, serviceId)
    }
  }

  /**
   * @private
   * @param {string} type
   * @param {any} body
   * @param {anty} parsedFile
   * @returns {Promise}
   */
  async _getIdentifierFromImports (type, body, parsedFile, importNameForAgument = null) {
    try {
      let rootDir = parsedFile.dir
      let relativeImportForImplement = await this._getRelativeImport(body, type, importNameForAgument)
      const configPaths = this._tsConfigPaths ?? []
      
      for (const pathConfig in configPaths) {
        const tsConfigPath = pathConfig.replace(/\*/g, '')
        const tsRelativePath = this._tsConfigPaths[pathConfig][0].replace(/\*/g, '')
        if (!relativeImportForImplement.includes(tsConfigPath)) {
          continue
        }
        relativeImportForImplement = relativeImportForImplement.replace(
          tsConfigPath,
          tsRelativePath
        )
        const parsedTsConfigPath = path.parse(this._tsConfigFullPath)
        rootDir = parsedTsConfigPath.dir
      }
   
      const absolutePathImportForImplement = path.join(
        rootDir,
        relativeImportForImplement
      )
      return this._getServiceIdFromPath(absolutePathImportForImplement, type)
    } catch (e) {
    }
  }

  /**
   * @private
   * @param {any} body
   * @param {string} type
   * @returns {Promise}
   */
  async _getRelativeImport (body, type, importNameForAgument = null) {
    return body.find((declaration) => {
      if(importNameForAgument){
        type = importNameForAgument
      }
      
      if (declaration.specifiers) {
        return declaration.specifiers.find((specifier) => {
          return specifier.local.name === type
        })
      }
      return null
    }).source.value
  }

  /**
   * @param {ServiceFile} serviceFile
   */
  set serviceFile (serviceFile) {
    this._serviceFile = serviceFile
  }

  /**
   * @returns {ServiceFile}
   */
  get serviceFile () {
    return this._serviceFile
  }
}
