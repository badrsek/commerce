import { PluginFunction } from '@graphql-codegen/plugin-helpers';
import { buildScalars } from '@graphql-codegen/visitor-plugin-common';
import {
    ASTNode,
    ASTVisitor,
    FieldDefinitionNode,
    getNamedType,
    GraphQLFieldMap,
    GraphQLNamedType,
    GraphQLObjectType,
    GraphQLSchema,
    GraphQLType,
    GraphQLUnionType,
    InterfaceTypeDefinitionNode,
    isNamedType,
    isObjectType,
    isTypeDefinitionNode,
    isUnionType,
    Kind,
    ListTypeNode,
    NonNullTypeNode,
    ObjectTypeDefinitionNode,
    parse,
    printSchema,
    UnionTypeDefinitionNode,
    visit,
} from 'graphql';
import { ASTVisitFn } from 'graphql/language/visitor';

// This plugin generates classes for all GraphQL types which implement the `ErrorResult` interface.
// This means that when returning an error result from a GraphQL operation, you can use one of
// the generated classes rather than constructing the object by hand.
// It also generates type resolvers to be used by Apollo Server to discriminate between
// members of returned union types.

export const ERROR_INTERFACE_NAME = 'ErrorResult';
const empty = () => '';

type TransformedField = { name: string; type: string };

const errorsVisitor: ASTVisitFn<ASTNode> = (node, key, parent) => {
    switch (node.kind) {
        case Kind.NON_NULL_TYPE: {
            return node.type.kind === 'NamedType'
                ? node.type.name.value
                : node.type.kind === 'ListType'
                ? node.type
                : '';
        }
        case Kind.FIELD_DEFINITION: {
            const type = (node.type.kind === 'ListType' ? node.type.type : node.type) as unknown as string;
            const tsType = isScalar(type) ? `Scalars['${type}']` : 'any';
            const listPart = node.type.kind === 'ListType' ? `[]` : ``;
            return { name: node.name.value, type: `${tsType}${listPart}` };
        }
        case Kind.SCALAR_TYPE_DEFINITION: {
            return '';
        }
        case Kind.INPUT_OBJECT_TYPE_DEFINITION: {
            return '';
        }
        case Kind.ENUM_TYPE_DEFINITION: {
            return '';
        }
        case Kind.UNION_TYPE_DEFINITION: {
            return '';
        }
        case Kind.INTERFACE_TYPE_DEFINITION: {
            if (node.name.value !== ERROR_INTERFACE_NAME) {
                return '';
            }
            return [
                `export class ${ERROR_INTERFACE_NAME} {`,
                `  readonly __typename: string;`,
                `  readonly errorCode: string;`,
                ...node.fields
                    .filter(f => (f as any as TransformedField).name !== 'errorCode')
                    .map(f => `  readonly ${f.name}: ${f.type};`),
                `}`,
            ].join('\n');
        }
        case Kind.OBJECT_TYPE_DEFINITION: {
            if (!inheritsFromErrorResult(node)) {
                return '';
            }
            const originalNode = parent[key] as ObjectTypeDefinitionNode;
            const constructorArgs = (node.fields as any as TransformedField[]).filter(
                f => f.name !== 'errorCode' && f.name !== 'message',
            );

            return [
                `export class ${node.name.value} extends ${ERROR_INTERFACE_NAME} {`,
                `  readonly __typename = '${node.name.value}';`,
                // We cast this to "any" otherwise we need to specify it as type "ErrorCode",
                // which means shared ErrorResult classes e.g. OrderStateTransitionError
                // will not be compatible between the admin and shop variations.
                `  readonly errorCode = '${camelToUpperSnakeCase(node.name.value)}' as any;`,
                `  readonly message = '${camelToUpperSnakeCase(node.name.value)}';`,
                ...constructorArgs.map(f => `  readonly ${f.name}: ${f.type};`),
                `  constructor(`,
                constructorArgs.length
                    ? `    input: { ${constructorArgs.map(f => `${f.name}: ${f.type}`).join(', ')} }`
                    : '',
                `  ) {`,
                `    super();`,
                ...(constructorArgs.length
                    ? constructorArgs.map(f => `    this.${f.name} = input.${f.name}`)
                    : []),
                `  }`,
                `}`,
            ].join('\n');
        }
    }
};

export const plugin: PluginFunction<any> = (schema, documents, config, info) => {
    const printedSchema = printSchema(schema); // Returns a string representation of the schema
    const astNode = parse(printedSchema); // Transforms the string into ASTNode
    const result = visit(astNode, { leave: errorsVisitor });
    const defs = result.definitions
        .filter(d => !!d)
        // Ensure the ErrorResult base class is first
        .sort((a, b) => ((a as any).includes('class ErrorResult') ? -1 : 1));
    return {
        content: [
            `/** This file was generated by the graphql-errors-plugin, which is part of the "codegen" npm script. */`,
            generateScalars(schema, config),
            ...defs,
            defs.length ? generateIsErrorFunction(schema) : '',
            generateTypeResolvers(schema),
        ].join('\n\n'),
    };
};

function generateScalars(schema: GraphQLSchema, config: any): string {
    const scalarMap = buildScalars(schema, config.scalars);
    const allScalars = Object.keys(scalarMap)
        .map(scalarName => {
            const scalarValue = scalarMap[scalarName].output.type;
            const scalarType = schema.getType(scalarName);

            return `  ${scalarName}: ${scalarValue};`;
        })
        .join('\n');
    return `export type Scalars = {\n${allScalars}\n};`;
}

function generateErrorClassSource(node: ObjectTypeDefinitionNode) {
    let source = `export class ${node.name.value} {`;
    for (const field of node.fields) {
        source += `  ${1}`;
    }
}

function generateIsErrorFunction(schema: GraphQLSchema) {
    const errorNodes = Object.values(schema.getTypeMap())
        .filter(isObjectType)
        .filter(node => inheritsFromErrorResult(node));
    return `
const errorTypeNames = new Set<string>([${errorNodes.map(n => `'${n.name}'`).join(', ')}]);
function isGraphQLError(input: any): input is import('@vendure/common/lib/generated-types').${ERROR_INTERFACE_NAME} {
  return input instanceof ${ERROR_INTERFACE_NAME} || errorTypeNames.has(input.__typename);
}`;
}

function generateTypeResolvers(schema: GraphQLSchema) {
    const mutations = getOperationsThatReturnErrorUnions(schema, schema.getMutationType().getFields());
    const queries = getOperationsThatReturnErrorUnions(schema, schema.getQueryType().getFields());
    const operations = [...mutations, ...queries];
    const varName = isAdminApi(schema)
        ? `adminErrorOperationTypeResolvers`
        : `shopErrorOperationTypeResolvers`;
    const result = [`export const ${varName} = {`];
    const typesHandled = new Set<string>();
    for (const operation of operations) {
        const returnType = unwrapType(operation.type) as GraphQLUnionType;
        if (!typesHandled.has(returnType.name)) {
            typesHandled.add(returnType.name);
            const nonErrorResult = returnType.getTypes().find(t => !inheritsFromErrorResult(t));
            result.push(
                `  ${returnType.name}: {`,
                `    __resolveType(value: any) {`,
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                `      return isGraphQLError(value) ? (value as any).__typename : '${nonErrorResult!.name}';`,
                `    },`,
                `  },`,
            );
        }
    }
    result.push(`};`);
    return result.join('\n');
}

function getOperationsThatReturnErrorUnions(schema: GraphQLSchema, fields: GraphQLFieldMap<any, any>) {
    return Object.values(fields).filter(operation => {
        const innerType = unwrapType(operation.type);
        if (isUnionType(innerType)) {
            return isUnionOfResultAndErrors(schema, innerType.getTypes());
        }
        return false;
    });
}

function isUnionOfResultAndErrors(schema: GraphQLSchema, types: ReadonlyArray<GraphQLObjectType>) {
    const errorResultTypes = types.filter(type => {
        if (isObjectType(type)) {
            if (inheritsFromErrorResult(type)) {
                return true;
            }
        }
        return false;
    });
    return (errorResultTypes.length = types.length - 1);
}

function isObjectTypeDefinition(node: any): node is ObjectTypeDefinitionNode {
    return node && isTypeDefinitionNode(node) && node.kind === 'ObjectTypeDefinition';
}

function inheritsFromErrorResult(node: ObjectTypeDefinitionNode | GraphQLObjectType): boolean {
    const interfaceNames = isObjectType(node)
        ? node.getInterfaces().map(i => i.name)
        : node.interfaces.map(i => i.name.value);
    return interfaceNames.includes(ERROR_INTERFACE_NAME);
}

/**
 * Unwraps the inner type from a higher-order type, e.g. [Address!]! => Address
 */
function unwrapType(type: GraphQLType): GraphQLNamedType {
    return getNamedType(type);
}

function isAdminApi(schema: GraphQLSchema): boolean {
    return !!schema.getType('UpdateGlobalSettingsInput');
}

function camelToUpperSnakeCase(input: string): string {
    return input.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
}

function isScalar(type: string): boolean {
    return ['ID', 'String', 'Boolean', 'Int', 'Float', 'JSON', 'DateTime', 'Upload'].includes(type);
}